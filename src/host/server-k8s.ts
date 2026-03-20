// src/host/server-k8s.ts — Unified host pod process for k8s deployment.
//
// Handles HTTP requests, SSE streaming, webhooks, admin dashboard,
// AND runs processCompletion() directly (merged agent-runtime).
//
// Each turn spawns a sandbox pod via the k8s sandbox provider,
// starts per-turn NATS IPC handler + LLM proxy, and streams events
// back to SSE clients via the NATS EventBus.
//
// For local development, use server-local.ts instead (all-in-one process).

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { getLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { screenReleaseChanges } from './workspace-release-screener.js';
import { loadProviders } from './registry.js';
import { sendError, readBody } from './server-http.js';
import { agentDir as agentDirPath } from '../paths.js';
import type { IPCContext } from './ipc-server.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { SharedCredentialRegistry } from './credential-placeholders.js';
import type { EventBus } from './event-bus.js';
import { natsConnectOptions } from '../utils/nats.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';

// Shared extraction modules
import { initHostCore } from './server-init.js';
import {
  createRequestHandler,
  createSchedulerCallback,
} from './server-request-handlers.js';
import { setupWebhookHandler, setupAdminHandler } from './server-webhook-admin.js';
import { isAgentBootstrapMode, isAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';

const logger = getLogger().child({ component: 'host-process' });

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

  // ── Shared initialization (storage, routing, IPC, templates, orchestrator) ──
  const core = await initHostCore({ config, providers, eventBus, verbose: process.env.AX_VERBOSE === '1' });
  const {
    completionDeps, sessionStore, router, taintBudget, fileStore,
    handleIPC, ipcServer, ipcSocketPath, ipcSocketDir, orchestrator, disableAutoState,
    agentRegistry, agentName, agentDirVal, sessionCanaries,
    defaultUserId, modelId,
  } = core;

  // ── Host-process-specific: shared credential registry for k8s MITM proxy ──
  const agentSandbox = providers.sandbox;
  const sharedCredentialRegistry = new SharedCredentialRegistry();
  completionDeps.providers = { ...providers, sandbox: agentSandbox };
  completionDeps.sharedCredentialRegistry = sharedCredentialRegistry;

  // ── NATS connection (for EventBus SSE streaming) ──

  const natsModule = await import('nats');
  const nc = await natsModule.connect(natsConnectOptions('host'));
  logger.info('nats_connected', { url: natsConnectOptions('host').servers });

  // ── Web proxy for agent outbound HTTP/HTTPS access ──

  let webProxy: WebProxy | undefined;
  if (config.web_proxy) {
    const webProxyPort = parseInt(process.env.AX_PROXY_LISTEN_PORT ?? '3128', 10);
    const { requestApproval } = await import('./web-proxy-approvals.js');

    // MITM config for credential injection — shared across all sessions.
    const { getOrCreateCA } = await import('./proxy-ca.js');
    const caDir = join(agentDirPath(agentName), 'ca');
    const ca = await getOrCreateCA(caDir);

    webProxy = await startWebProxy({
      listen: webProxyPort,
      bindHost: '0.0.0.0',
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
      onApprove: async (domain, method, url) => {
        logger.info('web_proxy_approval_required', { domain, method, url });
        const proxyRequestId = `proxy-${randomUUID().slice(0, 8)}`;
        const approved = await requestApproval('host-process', domain, eventBus, proxyRequestId);
        return { approved, reason: approved ? undefined : `Network access to ${domain} requires user approval` };
      },
      mitm: {
        ca,
        credentials: sharedCredentialRegistry,
        bypassDomains: new Set(config.mitm_bypass_domains ?? []),
      },
      urlRewrites: config.url_rewrites
        ? new Map(Object.entries(config.url_rewrites))
        : undefined,
    });
    logger.info('web_proxy_started', { port: webProxyPort, mitm: true });
  }

  const port = parseInt(process.env.PORT ?? '8080', 10);
  const agentType = config.agent ?? 'pi-coding-agent';
  let draining = false;

  // ── Webhook handler ──

  const webhookPrefix = config.webhooks?.path
    ? (config.webhooks.path.endsWith('/') ? config.webhooks.path : config.webhooks.path + '/')
    : '/webhooks/';

  const webhookHandler = setupWebhookHandler({
    config,
    providers,
    logger,
    taintBudget,
    dispatch: (result, runId) => {
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
  });

  // ── Admin handler ──

  const startTime = Date.now();
  const adminHandler = setupAdminHandler({
    config,
    providers,
    eventBus: providers.eventbus,
    agentRegistry,
    startTime,
  });

  // ── processCompletion wrapper with per-turn NATS IPC ──

  async function processCompletionWithNATS(
    content: string | import('../types.js').ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | import('../types.js').ContentBlock[] }[],
    sessionId: string,
    userId?: string,
    _agentType?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
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

              // Screen skill files and binaries before committing
              const screening = await screenReleaseChanges(changes, {
                screener: providers.screener,
                audit: providers.audit,
                sessionId,
              });
              if (screening.rejected.length > 0) {
                logger.warn('workspace_release_rejected_files', {
                  requestId,
                  rejected: screening.rejected.map(r => ({ path: r.path, reason: r.reason })),
                });
              }

              if (providers.workspace?.setRemoteChanges) {
                providers.workspace.setRemoteChanges(sessionId, screening.accepted);
              }

              logger.info('workspace_release_stored', { requestId, stagingKey, changeCount: screening.accepted.length });
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
    if (isK8s) {
      activeTokens.set(turnToken, {
        handleIPC: wrappedHandleIPC,
        ctx: { sessionId, agentId: 'main', userId: userId ?? defaultUserId, requestId },
        provisionIds: { agent: agentName, user: userId ?? defaultUserId, session: sessionId },
      });
      logger.info('token_registered', { sessionId, requestId, tokenPresent: true });
    }

    // NATS work publisher
    const publishWork = isK8s
      ? async (podName: string | undefined, payload: string): Promise<string> => {
          const encoded = new TextEncoder().encode(payload);
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
          throw new Error('publishWork: exhausted retries');
        }
      : undefined;

    // Pass per-turn token + NATS helpers to sandbox via deps
    const turnDeps: CompletionDeps = {
      ...completionDeps,
      extraSandboxEnv: {
        AX_IPC_TOKEN: turnToken,
        AX_IPC_REQUEST_ID: requestId,
        AX_HOST_URL: `http://ax-host.${config.namespace ?? 'ax'}.svc`,
        ...(config.web_proxy ? { AX_WEB_PROXY_URL: `http://ax-web-proxy.${config.namespace ?? 'ax'}.svc:3128` } : {}),
      },
      ...(agentResponsePromise ? { agentResponsePromise } : {}),
      ...(publishWork ? { publishWork } : {}),
    };

    const sessionStartTime = Date.now();
    try {
      const result = await processCompletion(
        turnDeps,
        content,
        requestId,
        messages,
        sessionId,
        preProcessed,
        userId,
      );

      logger.info('session_completed', {
        requestId,
        sessionId,
        responseLength: result.responseContent.length,
        finishReason: result.finishReason,
        durationMs: Date.now() - sessionStartTime,
      });

      return result;
    } finally {
      if (agentTimer) clearTimeout(agentTimer);
      activeTokens.delete(turnToken);
    }
  }

  // ── Graceful drain tracking ──

  let inflightCount = 0;
  let drainResolve: (() => void) | null = null;
  const DRAIN_TIMEOUT_MS = 30_000;

  function trackRequestStart(): void { inflightCount++; }
  function trackRequestEnd(): void {
    inflightCount--;
    if (draining && inflightCount <= 0 && drainResolve) drainResolve();
  }

  function waitForDrain(): Promise<void> {
    if (inflightCount <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainResolve = resolve;
      setTimeout(() => {
        if (inflightCount > 0) logger.warn('drain_timeout', { inflight: inflightCount, timeoutMs: DRAIN_TIMEOUT_MS });
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
  }

  // ── Workspace staging endpoint (k8s pod file upload) ──

  async function handleWorkspaceStaging(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  // ── k8s-specific /internal/* routes ──

  async function handleInternalRoutes(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    // Direct workspace release from sandbox pods (k8s HTTP mode)
    if (url === '/internal/workspace/release' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return true;
      }
      try {
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += (chunk as Buffer).length;
          if (totalSize > MAX_STAGING_BYTES) {
            sendError(res, 413, 'Payload too large');
            return true;
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

        // Screen skill files and binaries before committing
        const screening = await screenReleaseChanges(changes, {
          screener: providers.screener,
          audit: providers.audit,
          sessionId: entry.ctx.sessionId,
        });
        if (screening.rejected.length > 0) {
          logger.warn('workspace_release_rejected_files', {
            rejected: screening.rejected.map(r => ({ path: r.path, reason: r.reason })),
          });
        }

        if (providers.workspace?.setRemoteChanges) {
          providers.workspace.setRemoteChanges(entry.ctx.sessionId, screening.accepted);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, changeCount: changes.length }));
      } catch (err) {
        logger.error('workspace_release_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Workspace release failed');
      }
      return true;
    }

    // Workspace provision: sandbox pods download scope files from host
    if (url.startsWith('/internal/workspace/provision') && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return true;
      }
      try {
        const params = new URL(url, 'http://localhost').searchParams;
        const scope = params.get('scope') as 'agent' | 'user' | 'session';
        const id = params.get('id');
        if (!scope || !id || !providers.workspace?.downloadScope) {
          sendError(res, 400, 'Missing scope/id or workspace provider has no downloadScope');
          return true;
        }
        if (entry.provisionIds) {
          const expectedId = entry.provisionIds[scope];
          if (expectedId !== undefined && id !== expectedId) {
            logger.warn('workspace_provision_id_mismatch', { scope, requestedId: id, expectedId });
            sendError(res, 403, 'Scope ID does not match token context');
            return true;
          }
        }
        const files = await providers.workspace.downloadScope(scope, id);
        const jsonStr = JSON.stringify({
          files: files.map(f => ({ path: f.path, content_base64: f.content.toString('base64'), size: f.content.length })),
        });
        const gzipped = gzipSync(Buffer.from(jsonStr));
        logger.info('workspace_provision', { scope, id, fileCount: files.length, bytes: gzipped.length });
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(gzipped.length) });
        res.end(gzipped);
      } catch (err) {
        logger.error('workspace_provision_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Workspace provision failed');
      }
      return true;
    }

    // Workspace staging upload from sandbox pods (k8s, legacy)
    if (url === '/internal/workspace-staging' && req.method === 'POST') {
      try {
        await handleWorkspaceStaging(req, res);
      } catch (err) {
        logger.error('workspace_staging_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'Staging upload failed');
      }
      return true;
    }

    // LLM proxy over HTTP from sandbox pods
    if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
      const token = req.headers['x-api-key'] as string;
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return true;
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
      return true;
    }

    // IPC over HTTP from sandbox pods
    if (url === '/internal/ipc' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid token' }));
        return true;
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
      return true;
    }

    return false;
  }

  // ── Request Handler (via shared factory) ──

  const handleRequest = createRequestHandler({
    modelId,
    agentName,
    agentDirVal,
    eventBus,
    providers,
    fileStore: core.fileStore,
    taintBudget: core.taintBudget,
    completionOpts: {
      modelId,
      agentName,
      agentDirVal,
      eventBus,
      runCompletion: async (content, requestId, messages, sessionId, userId) => {
        return processCompletionWithNATS(content, requestId, messages, sessionId, userId, agentType);
      },
      preFlightCheck: (sessionId: string, userId: string | undefined) => {
        if (userId && isAgentBootstrapMode(agentName) && !isAdmin(agentDirVal, userId)) {
          if (claimBootstrapAdmin(agentDirVal, userId)) {
            logger.info('bootstrap_admin_claimed', { provider: 'http', sender: userId });
            return undefined;
          }
          return 'This agent is still being set up. Only admins can interact during bootstrap.';
        }
        return undefined;
      },
    },
    webhookPrefix,
    webhookHandler,
    adminHandler,
    isDraining: () => draining,
    trackRequestStart,
    trackRequestEnd,
    extraRoutes: handleInternalRoutes,
  });

  // ── Start HTTP server ──

  const server: HttpServer = createHttpServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, '0.0.0.0', () => {
      logger.info('host_listening', { port });
      resolve();
    });
    server.on('error', reject);
  });

  // ── Start scheduler ──

  const schedulerCallback = createSchedulerCallback({
    config,
    router,
    sessionCanaries,
    sessionStore,
    agentName,
    channels: providers.channels,
    scheduler: providers.scheduler,
    runCompletion: async (content, requestId, messages, sessionId, userId, preProcessed) => {
      return processCompletionWithNATS(
        content, requestId,
        messages as { role: string; content: string | import('../types.js').ContentBlock[] }[],
        sessionId,
        userId,
        undefined,
        preProcessed,
      );
    },
  });
  await providers.scheduler.start(schedulerCallback);
  logger.info('scheduler_started');

  // ── Graceful shutdown ──

  const shutdown = async () => {
    draining = true;
    logger.info('host_shutting_down');

    if (inflightCount > 0) {
      logger.info('graceful_drain_start', { inflight: inflightCount });
      await waitForDrain();
      logger.info('graceful_drain_complete');
    }

    await providers.scheduler.stop();

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
