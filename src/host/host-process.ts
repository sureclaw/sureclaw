// src/host/host-process.ts — Unified host pod process for k8s deployment.
//
// Handles HTTP requests, SSE streaming, webhooks, admin dashboard,
// AND runs processCompletion() directly (merged agent-runtime).
//
// Each turn spawns a sandbox pod via the k8s sandbox provider,
// starts per-turn NATS IPC handler + LLM proxy, and streams events
// back to SSE clients via the NATS EventBus.
//
// For local development, use server.ts instead (all-in-one process).

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, mkdirSync, mkdtempSync, copyFileSync, cpSync, writeFileSync, readdirSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { loadProviders } from './registry.js';
import { sendError, sendSSEChunk, readBody } from './server-http.js';
import type { OpenAIChatRequest } from './server-http.js';
import { isValidSessionId, webhookTransformPath, dataDir, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir, agentSkillsDir } from '../paths.js';
import { createWebhookHandler } from './server-webhooks.js';
import { createWebhookTransform } from './webhook-transform.js';
import { createAdminHandler } from './server-admin.js';
import { createAgentRegistry } from './agent-registry.js';
import { createRouter } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { createOrchestrator } from './orchestration/orchestrator.js';
import { FileStore } from '../file-store.js';
import { templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { decode, eventSubject } from './nats-session-protocol.js';
import type { StreamEvent } from './event-bus.js';
import type { EventBus } from './event-bus.js';
import { natsConnectOptions } from '../utils/nats.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';

const logger = getLogger().child({ component: 'host-process' });

/** SSE keepalive interval. */
const SSE_KEEPALIVE_MS = 15_000;

/** Max staging upload size (50MB uncompressed). */
const MAX_STAGING_BYTES = 50 * 1024 * 1024;

/** Staging data TTL — entries expire after 5 minutes. */
const STAGING_TTL_MS = 5 * 60 * 1000;

interface StagingEntry {
  data: Buffer;
  createdAt: number;
}

/**
 * In-memory store for workspace staging uploads from agent pods.
 * Agent uploads gzipped changes via HTTP, gets back a staging_key,
 * then references that key in a small NATS IPC workspace_release message.
 */
const stagingStore = new Map<string, StagingEntry>();

/**
 * Token registry: maps per-turn tokens to their bound IPC handler + context.
 * Registered before sandbox spawn, deleted in finally block.
 * Used by /internal/ipc and /internal/llm-proxy HTTP routes.
 */
export const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
  /** Expected scope IDs for workspace provision — validates caller-supplied scope/id pairs. */
  provisionIds?: { agent: string; user: string; session: string };
}>();

/** Periodically clean up expired staging entries. */
function cleanupStaging(): void {
  const now = Date.now();
  for (const [key, entry] of stagingStore) {
    if (now - entry.createdAt > STAGING_TTL_MS) {
      stagingStore.delete(key);
    }
  }
}

async function main(): Promise<void> {
  await initTracing();

  const config = loadConfig();
  const providers = await loadProviders(config);
  const eventBus: EventBus = providers.eventbus;

  // ── Staging store cleanup (workspace release from k8s pods) ──
  const stagingCleanupInterval = setInterval(cleanupStaging, 60_000);
  stagingCleanupInterval.unref();

  // ── Initialize storage, routing, IPC (merged from agent-runtime) ──

  mkdirSync(dataDir(), { recursive: true });
  const db = providers.storage.messages;
  const conversationStore = providers.storage.conversations;
  const taintBudget = new TaintBudget({ threshold: thresholdForProfile(config.profile) });
  const router = createRouter(providers, db, { taintBudget });

  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  const agentConfigDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirVal, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // Template seeding — seed to both filesystem and DocumentStore
  const templatesDir = resolveTemplatesDir();
  const documents = providers.storage.documents;

  // Check both filesystem AND DocumentStore for bootstrap completion
  const fsBootstrapComplete =
    existsSync(join(identityFilesDir, 'SOUL.md')) && existsSync(join(identityFilesDir, 'IDENTITY.md'));
  let dbBootstrapComplete = false;
  try {
    const dbSoul = await documents.get('identity', `${agentName}/SOUL.md`);
    const dbIdentity = await documents.get('identity', `${agentName}/IDENTITY.md`);
    dbBootstrapComplete = !!(dbSoul && dbIdentity);
  } catch { /* non-fatal */ }
  const bootstrapAlreadyComplete = fsBootstrapComplete || dbBootstrapComplete;

  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const dest = join(identityFilesDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
    if (existsSync(src)) {
      const key = `${agentName}/${file}`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }
  for (const file of ['capabilities.yaml']) {
    const dest = join(agentConfigDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) copyFileSync(src, dest);
  }
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      if (!existsSync(join(agentConfigDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(agentConfigDir, 'BOOTSTRAP.md'));
      if (!existsSync(join(identityFilesDir, 'BOOTSTRAP.md'))) copyFileSync(src, join(identityFilesDir, 'BOOTSTRAP.md'));
      const key = `${agentName}/BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(src, 'utf-8'));
      } catch { /* non-fatal */ }
    }
    const ubSrc = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(ubSrc)) {
      const key = `${agentName}/USER_BOOTSTRAP.md`;
      try {
        const existing = await documents.get('identity', key);
        if (!existing) await documents.put('identity', key, readFileSync(ubSrc, 'utf-8'));
      } catch { /* non-fatal */ }
    }
  }

  // Skills seeding
  const persistentSkillsDir = agentSkillsDir(agentName);
  mkdirSync(persistentSkillsDir, { recursive: true });
  try {
    const existingSkills = readdirSync(persistentSkillsDir).filter(f => f.endsWith('.md'));
    const existingDirs = readdirSync(persistentSkillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(join(persistentSkillsDir, d.name, 'SKILL.md')));
    if (existingSkills.length === 0 && existingDirs.length === 0) {
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        const seedEntries = readdirSync(seedDir, { withFileTypes: true });
        for (const entry of seedEntries) {
          if (entry.isFile() && entry.name.endsWith('.md')) {
            copyFileSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name));
          } else if (entry.isDirectory()) {
            cpSync(join(seedDir, entry.name), join(persistentSkillsDir, entry.name), { recursive: true });
          }
        }
      }
    }
  } catch { /* non-fatal */ }

  const defaultUserId = process.env.USER ?? 'default';

  // Admins file
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) writeFileSync(adminsPath, '', 'utf-8');

  // IPC server (Unix socket for local sandbox fallback)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const sessionCanaries = new Map<string, string>();
  const workspaceMap = new Map<string, string>();
  const fileStore = await FileStore.create(providers.database);

  const agentSandbox = providers.sandbox;

  const completionDeps: CompletionDeps = {
    config,
    providers: { ...providers, sandbox: agentSandbox },
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    logger,
    verbose: process.env.AX_VERBOSE === '1',
    fileStore,
    eventBus,
    workspaceMap,
  };

  // Delegation handler
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    const tier = req.resourceTier ?? 'default';
    const tierConfig = config.sandbox.tiers?.[tier] ?? (tier === 'heavy'
      ? { memory_mb: 2048, cpus: 4 }
      : { memory_mb: config.sandbox.memory_mb, cpus: 1 });

    const childConfig = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      sandbox: {
        ...config.sandbox,
        memory_mb: tierConfig.memory_mb,
        tiers: {
          default: tierConfig,
          heavy: config.sandbox.tiers?.heavy ?? { memory_mb: 2048, cpus: 4 },
        },
        ...(req.timeoutSec ? { timeout_sec: req.timeoutSec } : {}),
      },
    };
    const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
    const taskPrompt = req.context ? `${req.context}\n\n---\n\nTask: ${req.task}` : req.task;
    const childRequestId = req.requestId ?? `delegate-${randomUUID().slice(0, 8)}`;
    const result = await processCompletion(childDeps, taskPrompt, childRequestId, [], undefined, undefined, ctx.userId);
    return result.responseContent;
  }

  const orchestrator = createOrchestrator(eventBus, providers.audit);
  const disableAutoState = orchestrator.enableAutoState();
  const agentRegistry = await createAgentRegistry(providers.database);
  await agentRegistry.ensureDefault();

  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: identityFilesDir,
    agentName,
    profile: config.profile,
    configModel: config.models?.default?.[0],
    onDelegate: handleDelegate,
    delegation: config.delegation ? {
      maxConcurrent: config.delegation.max_concurrent,
      maxDepth: config.delegation.max_depth,
    } : undefined,
    eventBus,
    orchestrator,
    agentRegistry,
    workspaceMap,
  });
  completionDeps.ipcHandler = handleIPC;

  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer = await createIPCServer(ipcSocketPath, handleIPC, defaultCtx);

  // ── NATS connection (for EventBus SSE streaming) ──

  const natsModule = await import('nats');
  const nc = await natsModule.connect(natsConnectOptions('host'));
  logger.info('nats_connected', { url: natsConnectOptions('host').servers });

  // ── Web proxy for agent outbound HTTP/HTTPS access ──

  let webProxy: WebProxy | undefined;
  if (config.web_proxy) {
    const webProxyPort = parseInt(process.env.AX_WEB_PROXY_PORT ?? '3128', 10);
    webProxy = await startWebProxy({
      listen: webProxyPort,
      sessionId: 'host-process',
      onAudit: (entry) => {
        providers.audit.log({
          action: entry.action,
          sessionId: entry.sessionId,
          args: { method: entry.method, url: entry.url, status: entry.status, requestBytes: entry.requestBytes, responseBytes: entry.responseBytes, blocked: entry.blocked },
          result: entry.blocked ? 'blocked' : 'success',
          durationMs: entry.durationMs,
        }).catch(() => {});
      },
    });
    logger.info('web_proxy_started', { port: webProxyPort });
  }

  const port = parseInt(process.env.PORT ?? '8080', 10);
  const agentType = config.agent ?? 'pi-coding-agent';
  const modelId = providers.llm.name;
  let draining = false;

  // ── Webhook handler (optional — only if config has webhooks.enabled) ──

  const webhookPrefix = config.webhooks?.path
    ? (config.webhooks.path.endsWith('/') ? config.webhooks.path : config.webhooks.path + '/')
    : '/webhooks/';

  const webhookHandler = config.webhooks?.enabled
    ? createWebhookHandler({
        config: {
          token: config.webhooks.token,
          maxBodyBytes: config.webhooks.max_body_bytes,
          model: config.webhooks.model,
          allowedAgentIds: config.webhooks.allowed_agent_ids,
        },
        transform: createWebhookTransform(
          providers.llm,
          config.webhooks.model ?? config.models?.fast?.[0] ?? config.models?.default?.[0] ?? 'claude-haiku-4-5-20251001',
        ),
        dispatch: (result, runId) => {
          // Fire-and-forget: process webhook completion asynchronously
          const targetAgent = result.agentId ?? agentType;
          const whSessionId = result.sessionKey ?? `webhook:${runId}`;
          void processCompletionWithNATS(
            result.message,
            runId,
            [{ role: 'user', content: result.message }],
            whSessionId,
            'webhook',
            targetAgent,
          ).catch((err) => {
            logger.error('webhook_completion_failed', { runId, error: (err as Error).message });
          });
        },
        logger,
        transformExists: (name) => existsSync(webhookTransformPath(name)),
        readTransform: (name) => readFileSync(webhookTransformPath(name), 'utf-8'),
        audit: (entry) => {
          providers.audit.log({
            action: entry.action,
            sessionId: entry.runId ?? 'webhook',
            args: { webhook: entry.webhook, ip: entry.ip },
            result: 'success',
            durationMs: 0,
          }).catch(() => {});
        },
      })
    : null;

  // ── Admin dashboard handler (optional — only if config has admin.enabled) ──

  const startTime = Date.now();
  const adminHandler = config.admin?.enabled
    ? createAdminHandler({
        config,
        providers,
        eventBus: providers.eventbus,
        agentRegistry,
        startTime,
      })
    : null;

  // ── processCompletion wrapper with per-turn NATS IPC ──

  async function processCompletionWithNATS(
    content: string | import('../types.js').ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | import('../types.js').ContentBlock[] }[],
    sessionId: string,
    userId?: string,
    _agentType?: string,
  ): Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter'; contentBlocks?: import('../types.js').ContentBlock[] }> {
    // Per-turn capability token for NATS subject isolation
    const turnToken = randomUUID();
    const isK8s = config.providers.sandbox === 'k8s';

    // Set up agent_response interceptor: a Promise that resolves when the
    // agent sends { action: 'agent_response', content: '...' } via IPC.
    let agentResponseResolve: ((content: string) => void) | undefined;
    let agentResponseReject: ((err: Error) => void) | undefined;
    let agentResponsePromise: Promise<string> | undefined;
    let agentTimer: ReturnType<typeof setTimeout> | undefined;

    if (isK8s) {
      agentResponsePromise = new Promise<string>((resolve, reject) => {
        agentResponseResolve = resolve;
        agentResponseReject = reject;
      });

      // Safety timeout — if agent never sends agent_response, don't hang forever.
      const agentTimeoutMs = ((config.sandbox.timeout_sec ?? 600) + 60) * 1000;
      agentTimer = setTimeout(() => {
        agentResponseReject?.(new Error('agent_response timeout'));
      }, agentTimeoutMs);
      if (agentTimer.unref) agentTimer.unref();

      // Prevent unhandled rejection crash if the promise rejects after
      // processCompletion has already returned (e.g. timer fires late).
      // The real error handling happens in server-completions.ts try/catch.
      agentResponsePromise.catch(() => {});
    }

    // Wrap handleIPC to intercept workspace_release and agent_response actions
    const wrappedHandleIPC = isK8s
      ? async (raw: string, ctx: import('./ipc-server.js').IPCContext): Promise<string> => {
          try {
            const parsed = JSON.parse(raw);

            // Intercept workspace_release: look up staged changes by key and store for commit()
            if (parsed.action === 'workspace_release') {
              const stagingKey = parsed.staging_key as string;
              const entry = stagingStore.get(stagingKey);
              if (!entry) {
                logger.warn('workspace_release_missing_staging', { requestId, stagingKey });
                return JSON.stringify({ ok: false, error: 'staging_key not found' });
              }
              stagingStore.delete(stagingKey);

              // Decompress and parse the staged changes
              const json = gunzipSync(entry.data).toString('utf-8');
              const payload = JSON.parse(json) as { changes: Array<{ scope: string; path: string; type: string; content_base64?: string; size: number }> };

              const changes = (payload.changes ?? []).map((c) => ({
                scope: c.scope as 'agent' | 'user' | 'session',
                path: c.path,
                type: c.type as 'added' | 'modified' | 'deleted',
                content: c.content_base64 ? Buffer.from(c.content_base64, 'base64') : undefined,
                size: c.size,
              }));

              if (providers.workspace?.setRemoteChanges) {
                providers.workspace.setRemoteChanges(sessionId, changes);
              }

              logger.info('workspace_release_stored', { requestId, stagingKey, changeCount: changes.length });
              return JSON.stringify({ ok: true });
            }

            if (parsed.action === 'agent_response') {
              logger.info('agent_response_received', {
                requestId,
                contentLength: (parsed.content ?? '').length,
              });
              agentResponseResolve?.(parsed.content ?? '');
              return JSON.stringify({ ok: true });
            }
          } catch {
            // Not JSON or no action field — fall through to normal handler
          }
          return handleIPC(raw, ctx);
        }
      : handleIPC;

    // Register turn token for HTTP IPC route (/internal/ipc).
    // This allows the sandbox pod to call the host via HTTP with bearer token auth.
    if (isK8s) {
      activeTokens.set(turnToken, {
        handleIPC: wrappedHandleIPC,
        ctx: { sessionId, agentId: 'main', userId: userId ?? defaultUserId },
        provisionIds: { agent: agentName, user: userId ?? defaultUserId, session: sessionId },
      });
      logger.info('token_registered', { sessionId, requestId, turnToken });
    }

    // NATS work publisher — uses sandbox.work queue group for both warm pool
    // claiming and cold-start delivery. All runners subscribe to sandbox.work,
    // so we always use nc.request('sandbox.work') and let NATS route to an
    // available pod. For cold starts, we retry until the new pod subscribes.
    // NOTE: payload is already a JSON string (from JSON.stringify in server-completions).
    // Use TextEncoder directly — NOT encode() which adds an extra JSON.stringify wrapper,
    // causing double-encoding that destroys the payload structure on the receiver side.
    const publishWork = isK8s
      ? async (podName: string | undefined, payload: string): Promise<string> => {
          const encoded = new TextEncoder().encode(payload);
          // Cold-start path: the pod may take a few seconds to start and subscribe
          // to NATS. Retry nc.request until it connects (up to 60s).
          const maxAttempts = podName ? 120 : 1;
          const retryDelayMs = 500;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              const reply = await nc.request(
                'sandbox.work',
                encoded,
                { timeout: 5000 },
              );
              const { podName: claimedPod } = JSON.parse(new TextDecoder().decode(reply.data));
              logger.info('nats_work_claimed', { podName: claimedPod, payloadBytes: payload.length, attempt });
              return claimedPod;
            } catch (err) {
              if (attempt < maxAttempts) {
                logger.debug('nats_work_retry', { podName, attempt, maxAttempts });
                await new Promise(r => setTimeout(r, retryDelayMs));
                continue;
              }
              logger.info('nats_work_queue_timeout', { podName, error: (err as Error).message });
              throw err;
            }
          }
          // Unreachable, but TypeScript needs it
          throw new Error('publishWork: exhausted retries');
        }
      : undefined;

    // Pass per-turn token + NATS helpers to sandbox via deps
    const turnDeps: CompletionDeps = {
      ...completionDeps,
      extraSandboxEnv: {
        AX_IPC_TOKEN: turnToken,
        AX_IPC_REQUEST_ID: requestId,
        // Host URL — sandbox pods use this for workspace staging uploads
        AX_HOST_URL: `http://ax-host.${config.namespace ?? 'ax'}.svc`,
        // Web proxy — sandbox pods connect directly via k8s Service
        ...(config.web_proxy ? { AX_WEB_PROXY_URL: `http://ax-web-proxy.${config.namespace ?? 'ax'}.svc:3128` } : {}),
      },
      ...(agentResponsePromise ? { agentResponsePromise } : {}),
      ...(publishWork ? { publishWork } : {}),
    };

    try {
      const result = await processCompletion(
        turnDeps,
        content,
        requestId,
        messages,
        sessionId,
        undefined,
        userId,
      );

      logger.info('session_completed', {
        requestId,
        responseLength: result.responseContent.length,
        finishReason: result.finishReason,
      });

      return result;
    } finally {
      if (agentTimer) clearTimeout(agentTimer);
      activeTokens.delete(turnToken);
    }
  }

  // ── Request Handler ──

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (draining && (url === '/v1/chat/completions' || url.startsWith(webhookPrefix))) {
      sendError(res, 503, 'Server is shutting down');
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: draining ? 'draining' : 'ok' }));
      return;
    }

    if (url === '/v1/models' && req.method === 'GET') {
      const body = JSON.stringify({
        object: 'list',
        data: [{ id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ax' }],
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        await handleCompletions(req, res);
      } catch (err) {
        logger.error('request_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Internal server error');
      }
      return;
    }

    // SSE event stream: subscribe to NATS events
    if (url.startsWith('/v1/events') && req.method === 'GET') {
      handleEvents(req, res);
      return;
    }

    // Webhooks
    if (webhookHandler && url.startsWith(webhookPrefix)) {
      const webhookName = url.slice(webhookPrefix.length).split('?')[0];
      if (!webhookName) {
        sendError(res, 404, 'Not found');
        return;
      }
      try {
        await webhookHandler(req, res, webhookName);
      } catch (err) {
        logger.error('webhook_handler_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Webhook processing failed');
      }
      return;
    }

    // Redirect root to admin dashboard
    if (adminHandler && (url === '/' || url === '')) {
      res.writeHead(302, { Location: '/admin' });
      res.end();
      return;
    }

    // Admin dashboard: /admin/*
    if (adminHandler && url.startsWith('/admin')) {
      try {
        await adminHandler(req, res, url.split('?')[0]);
      } catch (err) {
        logger.error('admin_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Admin request failed');
      }
      return;
    }

    // Direct workspace release from sandbox pods (k8s HTTP mode)
    if (url === '/internal/workspace/release' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_STAGING_BYTES) {
            sendError(res, 413, 'Payload too large');
            return;
          }
          chunks.push(chunk as Buffer);
        }
        const compressed = Buffer.concat(chunks);
        const json = gunzipSync(compressed).toString('utf-8');
        const payload = JSON.parse(json) as { changes: Array<{ scope: string; path: string; type: string; content_base64?: string; size: number }> };
        const changes = (payload.changes ?? []).map((c) => ({
          scope: c.scope as 'agent' | 'user' | 'session',
          path: c.path,
          type: c.type as 'added' | 'modified' | 'deleted',
          content: c.content_base64 ? Buffer.from(c.content_base64, 'base64') : undefined,
          size: c.size,
        }));

        if (providers.workspace?.setRemoteChanges) {
          providers.workspace.setRemoteChanges(entry.ctx.sessionId, changes);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changeCount: changes.length }));
      } catch (err) {
        logger.error('workspace_release_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Workspace release failed');
      }
      return;
    }

    // Workspace provision: sandbox pods download scope files from host (host has GCS credentials, pods don't).
    // Mirrors the release endpoint — release uploads pod→host→GCS, provision downloads GCS→host→pod.
    if (url.startsWith('/internal/workspace/provision') && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const params = new URL(url, 'http://localhost').searchParams;
        const scope = params.get('scope') as 'agent' | 'user' | 'session';
        const id = params.get('id');
        if (!scope || !id || !providers.workspace?.downloadScope) {
          sendError(res, 400, 'Missing scope/id or workspace provider has no downloadScope');
          return;
        }
        // Validate requested scope/id against the token's bound context to prevent
        // a pod from requesting other users'/sessions' workspace data.
        if (entry.provisionIds) {
          const expectedId = entry.provisionIds[scope];
          if (expectedId !== undefined && id !== expectedId) {
            logger.warn('workspace_provision_id_mismatch', { scope, requestedId: id, expectedId });
            sendError(res, 403, 'Scope ID does not match token context');
            return;
          }
        }
        const files = await providers.workspace.downloadScope(scope, id);
        const json = JSON.stringify({
          files: files.map(f => ({ path: f.path, content_base64: f.content.toString('base64'), size: f.content.length })),
        });
        const gzipped = gzipSync(Buffer.from(json));
        logger.info('workspace_provision', { scope, id, fileCount: files.length, bytes: gzipped.length });
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(gzipped.length) });
        res.end(gzipped);
      } catch (err) {
        logger.error('workspace_provision_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Workspace provision failed');
      }
      return;
    }

    // Workspace staging upload from sandbox pods (k8s, legacy)
    if (url === '/internal/workspace-staging' && req.method === 'POST') {
      try {
        await handleWorkspaceStaging(req, res);
      } catch (err) {
        logger.error('workspace_staging_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Staging upload failed');
      }
      return;
    }

    // LLM proxy over HTTP from sandbox pods (k8s, AX_IPC_TRANSPORT=http)
    // Agent sends requests to /internal/llm-proxy/v1/messages with per-turn token as x-api-key.
    if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
      const token = req.headers['x-api-key'] as string;
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const targetPath = url.replace('/internal/llm-proxy', '');
        const body = await readBody(req, 10_485_760); // 10MB
        const { forwardLLMRequest } = await import('./llm-proxy-core.js');
        await forwardLLMRequest({
          targetPath,
          body: body.toString(),
          incomingHeaders: req.headers,
          res,
        });
      } catch (err) {
        logger.error('internal_llm_proxy_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 502, 'LLM proxy request failed');
      }
      return;
    }

    // IPC over HTTP from sandbox pods (k8s, AX_IPC_TRANSPORT=http)
    if (url === '/internal/ipc' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return;
      }
      try {
        const body = await readBody(req, 1_048_576); // 1MB max
        const result = await entry.handleIPC(body.toString(), entry.ctx);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(result);
      } catch (err) {
        logger.error('internal_ipc_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'IPC request failed');
      }
      return;
    }

    sendError(res, 404, 'Not found');
  }

  // ── Workspace staging endpoint (k8s pod file upload) ──

  async function handleWorkspaceStaging(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Read the gzipped request body
    const chunks: Buffer[] = [];
    let totalSize = 0;

    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_STAGING_BYTES) {
        sendError(res, 413, 'Staging payload too large');
        return;
      }
      chunks.push(chunk as Buffer);
    }

    const body = Buffer.concat(chunks);
    if (body.length === 0) {
      sendError(res, 400, 'Empty staging payload');
      return;
    }

    const key = randomUUID();
    stagingStore.set(key, { data: body, createdAt: Date.now() });

    logger.info('workspace_staging_stored', { key, bytes: body.length });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ staging_key: key }));
  }

  // ── Completions: direct processCompletion ──

  async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      sendError(res, 413, 'Request body too large');
      return;
    }

    let chatReq: OpenAIChatRequest;
    try {
      chatReq = JSON.parse(body);
    } catch {
      sendError(res, 400, 'Invalid JSON');
      return;
    }

    if (!chatReq.messages?.length) {
      sendError(res, 400, 'messages array is required');
      return;
    }

    if (chatReq.session_id !== undefined && !isValidSessionId(chatReq.session_id)) {
      sendError(res, 400, 'Invalid session_id');
      return;
    }

    const requestModel = chatReq.model ?? modelId;

    // Derive session ID
    let sessionId = chatReq.session_id;
    if (!sessionId && chatReq.user) {
      const parts = chatReq.user.split('/');
      if (parts.length >= 2 && parts[0] && parts[1]) {
        const agentPrefix = chatReq.model?.startsWith('agent:')
          ? chatReq.model.slice(6) : 'main';
        const candidate = `${agentPrefix}:http:${parts[0]}:${parts[1]}`;
        if (isValidSessionId(candidate)) sessionId = candidate;
      }
    }
    if (!sessionId) sessionId = randomUUID();

    const lastMsg = chatReq.messages[chatReq.messages.length - 1];
    const content = lastMsg?.content ?? '';
    const userId = chatReq.user?.split('/')[0] || undefined;

    if (chatReq.stream) {
      // ── Streaming mode ──
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
        'X-Accel-Buffering': 'no',
      });

      // Role chunk
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      let toolCallIndex = 0;
      let hasToolCalls = false;
      let streamedContent = false;

      // Subscribe to EventBus events for this request
      const unsubscribe = eventBus.subscribeRequest(requestId, (event: StreamEvent) => {
        try {
          if (event.type === 'llm.chunk' && typeof event.data.content === 'string') {
            streamedContent = true;
            sendSSEChunk(res, {
              id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
              choices: [{ index: 0, delta: { content: event.data.content as string }, finish_reason: null }],
            });
          } else if (event.type === 'tool.call' && event.data.toolName) {
            streamedContent = true;
            hasToolCalls = true;
            sendSSEChunk(res, {
              id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
              choices: [{ index: 0, delta: {
                tool_calls: [{
                  index: toolCallIndex++,
                  id: (event.data.toolId as string) ?? `call_${toolCallIndex}`,
                  type: 'function',
                  function: {
                    name: event.data.toolName as string,
                    arguments: JSON.stringify(event.data.args ?? {}),
                  },
                }],
              }, finish_reason: null }],
            });
          }
        } catch { /* client gone, skip */ }
      });

      // Keepalive
      const keepalive = setInterval(() => {
        try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
      }, SSE_KEEPALIVE_MS);

      // Stop keepalive + event listener when client disconnects mid-stream.
      // Without this, the timer keeps firing until processCompletion finishes.
      const onClientGone = () => {
        clearInterval(keepalive);
        unsubscribe();
      };
      req.on('close', onClientGone);
      req.on('error', onClientGone);

      try {
        const result = await processCompletionWithNATS(
          content, requestId, chatReq.messages, sessionId, userId, agentType,
        );

        // Fallback: if no streaming events, send full response as single chunk
        if (!streamedContent && result.responseContent) {
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: { content: result.responseContent }, finish_reason: null }],
          });
        }

        // Finish chunk
        const streamFinishReason = hasToolCalls && result.finishReason === 'stop'
          ? 'tool_calls' as const : result.finishReason;
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
        });
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        logger.error('completion_failed', { requestId, error: (err as Error).message });
        if (!res.writableEnded) {
          sendSSEChunk(res, {
            id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
            choices: [{ index: 0, delta: { content: 'Internal processing error' }, finish_reason: 'stop' }],
          });
          res.write('data: [DONE]\n\n');
          res.end();
        }
      } finally {
        clearInterval(keepalive);
        unsubscribe();
      }
    } else {
      // ── Non-streaming mode ──
      try {
        const result = await processCompletionWithNATS(
          content, requestId, chatReq.messages, sessionId, userId, agentType,
        );

        const response = {
          id: requestId, object: 'chat.completion', created, model: requestModel,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: result.responseContent },
            finish_reason: result.finishReason,
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        };

        const responseBody = JSON.stringify(response);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(responseBody);
      } catch (err) {
        logger.error('completion_failed', { requestId, error: (err as Error).message });
        sendError(res, 500, 'Internal server error');
      }
    }
  }

  // ── SSE events via NATS ──

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const requestIdFilter = parsedUrl.searchParams.get('request_id') ?? undefined;
    const typesParam = parsedUrl.searchParams.get('types') ?? undefined;
    const typeFilter = typesParam ? new Set(typesParam.split(',').map(t => t.trim()).filter(Boolean)) : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':connected\n\n');

    // Subscribe to NATS events
    const natsSubject = requestIdFilter
      ? eventSubject(requestIdFilter)
      : 'events.global';

    const sub = nc.subscribe(natsSubject);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
    }, SSE_KEEPALIVE_MS);

    // Forward NATS events to SSE
    (async () => {
      for await (const msg of sub) {
        try {
          const event = decode<StreamEvent>(msg.data);
          if (typeFilter && !typeFilter.has(event.type)) continue;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch { /* skip malformed */ }
      }
    })().catch(() => {});

    const cleanup = () => {
      clearInterval(keepalive);
      sub.unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  }

  // ── Start HTTP server ──

  const server: HttpServer = createHttpServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info('host_listening', { port });
      resolve();
    });
    server.on('error', reject);
  });

  // ── Graceful shutdown ──

  const shutdown = async () => {
    draining = true;
    logger.info('host_shutting_down');

    server.close();
    if (webProxy) webProxy.stop();
    disableAutoState();
    orchestrator.shutdown();

    try { ipcServer.close(); } catch { /* ignore */ }
    providers.eventbus.close();
    providers.storage.close();
    try { await fileStore.close(); } catch { /* ignore */ }

    await nc.drain();
    await shutdownTracing();

    try { unlinkSync(ipcSocketPath); } catch { /* ignore */ }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch { /* ignore */ }

    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error('[host-process] fatal:', err);
  process.exit(1);
});
