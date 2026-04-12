// src/host/server-k8s.ts — Unified host pod process for k8s deployment.
//
// Handles HTTP requests, SSE streaming, webhooks, admin dashboard,
// AND runs processCompletion() directly (merged agent-runtime).
//
// Each turn spawns a sandbox pod via the k8s sandbox provider,
// starts per-turn HTTP IPC handler + LLM proxy, and streams events
// back to SSE clients via the EventBus.
//
// For local development, use server-local.ts instead (all-in-one process).

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getLogger } from '../logger.js';
import { loadConfig } from '../config.js';
import { loadProviders } from './registry.js';
import { sendError, readBody } from './server-http.js';
import { agentDir as agentDirPath } from '../paths.js';
import type { IPCContext } from './ipc-server.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { SharedCredentialRegistry } from './credential-placeholders.js';
import type { EventBus } from './event-bus.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';

// Shared extraction modules
import { initHostCore } from './server-init.js';
import {
  createRequestHandler,
  createSchedulerCallback,
} from './server-request-handlers.js';
import { setupWebhookHandler, setupAdminHandler } from './server-webhook-admin.js';
import { isAgentBootstrapMode, isAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';
import { createSessionPodManager } from './session-pod-manager.js';

const logger = getLogger().child({ component: 'host-process' });

/**
 * Token registry: maps per-turn tokens to their bound IPC handler + context.
 * Registered before sandbox spawn, deleted in finally block.
 * Used by /internal/ipc, /internal/work, and /internal/llm-proxy HTTP routes.
 */
export const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
}>();

async function main(): Promise<void> {
  await initTracing();

  const config = loadConfig();
  const providers = await loadProviders(config);
  const eventBus: EventBus = providers.eventbus;

  // ── Session pod manager (tracks session-long pods) ──
  const sessionPodManager = createSessionPodManager({
    idleTimeoutMs: (config.sandbox?.idle_timeout_sec ?? 300) * 1000,
    cleanIdleTimeoutMs: (config.sandbox?.clean_idle_timeout_sec ?? 300) * 1000,
    warningLeadMs: 120_000,
    onKill: (sessionId) => {
      logger.info('session_pod_killed', { sessionId });
    },
  });

  // ── Shared initialization (storage, routing, IPC, templates, orchestrator) ──
  const core = await initHostCore({ config, providers, eventBus, verbose: process.env.AX_VERBOSE === '1' });
  const {
    completionDeps, sessionStore, router, taintBudget, fileStore,
    handleIPC, ipcServer, ipcSocketPath, ipcSocketDir, orchestrator, disableAutoState,
    agentRegistry, agentName, agentDirVal, sessionCanaries,
    domainList, defaultUserId, modelId, mcpManager,
  } = core;

  // ── Host-process-specific: shared credential registry for k8s MITM proxy ──
  const agentSandbox = providers.sandbox;
  const sharedCredentialRegistry = new SharedCredentialRegistry();
  completionDeps.providers = { ...providers, sandbox: agentSandbox };
  completionDeps.sharedCredentialRegistry = sharedCredentialRegistry;

  // ── Web proxy for agent outbound HTTP/HTTPS access ──

  let webProxy: WebProxy | undefined;
  if (config.web_proxy) {
    const webProxyPort = parseInt(process.env.AX_PROXY_LISTEN_PORT ?? '3128', 10);

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
      allowedDomains: { has: (d: string) => domainList.isAllowed(d) },
      onDenied: (domain) => domainList.addPending(domain, 'host-process'),
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
      void processCompletionForSession(
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
    domainList,
    mcpManager,
    externalAuth: !!providers.auth?.length,
  });

  // ── processCompletion wrapper with per-turn HTTP IPC ──

  async function processCompletionForSession(
    content: string | import('../types.js').ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | import('../types.js').ContentBlock[] }[],
    sessionId: string,
    userId?: string,
    _agentType?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
    baseDeps?: CompletionDeps,
  ): Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter'; contentBlocks?: import('../types.js').ContentBlock[] }> {
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
      agentResponsePromise.catch(() => {});
    }

    // IPC actions that indicate sandbox filesystem writes — mark session dirty.
    // workspace_write/workspace_release go to GCS via the host, not the sandbox FS.
    const DIRTY_ACTIONS = new Set([
      'sandbox_bash', 'sandbox_write_file', 'sandbox_edit_file',
    ]);

    // Wrap handleIPC to intercept agent_response and mark session dirty
    const wrappedHandleIPC = isK8s
      ? async (raw: string, ctx: import('./ipc-server.js').IPCContext): Promise<string> => {
          try {
            const parsed = JSON.parse(raw);

            if (parsed.action === 'agent_response') {
              logger.info('agent_response_received', {
                requestId,
                contentLength: (parsed.content ?? '').length,
              });
              agentResponseResolve?.(parsed.content ?? '');
              return JSON.stringify({ ok: true });
            }

            // Mark session dirty on write-capable IPC actions
            if (parsed.action && DIRTY_ACTIONS.has(parsed.action)) {
              sessionPodManager.markDirty(sessionId);
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
      });
      logger.info('token_registered', { sessionId, requestId, tokenPresent: true });
    }

    // Start the agent_response timeout timer
    const startAgentResponseTimer = isK8s
      ? () => {
          if (agentTimer) return;
          const effectiveTimeout = baseDeps?.config.sandbox.timeout_sec ?? config.sandbox?.timeout_sec ?? 600;
          const agentTimeoutMs = (effectiveTimeout + 60) * 1000;
          agentTimer = setTimeout(() => {
            agentResponseReject?.(new Error('agent_response timeout'));
          }, agentTimeoutMs);
          if (agentTimer.unref) agentTimer.unref();
        }
      : undefined;

    // Pass per-turn token to sandbox via deps
    const turnDeps: CompletionDeps = {
      ...(baseDeps ?? completionDeps),
      extraSandboxEnv: {
        AX_IPC_TOKEN: turnToken,
        AX_IPC_REQUEST_ID: requestId,
        AX_HOST_URL: `http://ax-host.${config.namespace ?? 'ax'}.svc`,
        ...(config.web_proxy ? { AX_WEB_PROXY_URL: `http://ax-web-proxy.${config.namespace ?? 'ax'}.svc:3128` } : {}),
      },
      ...(agentResponsePromise ? { agentResponsePromise } : {}),
      ...(startAgentResponseTimer ? { startAgentResponseTimer } : {}),
      ...(isK8s ? {
        queueWork: (sid: string, payload: string) => { sessionPodManager.queueWork(sid, payload); },
        getSessionPod: (sid: string) => {
          const pod = sessionPodManager.get(sid);
          return pod ? { podName: pod.podName, pid: pod.pid, kill: pod.kill } : undefined;
        },
        registerSessionPod: (sid: string, pod: { podName: string; pid: number; kill: () => void }) => {
          sessionPodManager.register(sid, { podName: pod.podName, pid: pod.pid, sessionId: sid, authToken: turnToken, kill: pod.kill });
        },
        removeSessionPod: (sid: string) => {
          if (sessionPodManager.has(sid)) {
            logger.info('session_pod_exited', { sessionId: sid });
            sessionPodManager.remove(sid);
          }
        },
      } : {}),
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
      // Start the idle countdown from turn end, not from last IPC activity.
      // Prevents the timer from getting a head start during long LLM calls
      // at the end of a turn (which make no IPC calls).
      if (isK8s && sessionPodManager.has(sessionId)) {
        sessionPodManager.touch(sessionId);
      }
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

  // ── k8s-specific /internal/* routes ──

  async function handleInternalRoutes(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
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

    // Pod work fetch: session-long pod polls for work
    if (url === '/internal/work' && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing token' }));
        return true;
      }
      // Authenticate: look up session by the pod's auth token (set at registration)
      const sid = sessionPodManager.findSessionByToken(token);
      const work = sid ? sessionPodManager.claimWork(sid) : undefined;
      if (!work) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no pending work for token' }));
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(work.payload);
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
    gcsFileStorage: core.gcsFileStorage,
    taintBudget: core.taintBudget,
    completionOpts: {
      modelId,
      agentName,
      agentDirVal,
      eventBus,
      runCompletion: async (content, requestId, messages, sessionId, userId) => {
        return processCompletionForSession(content, requestId, messages, sessionId, userId, agentType);
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
    authProviders: providers.auth,
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
    isBootstrapMode: () => isAgentBootstrapMode(agentName),
    runCompletion: async (content, requestId, messages, sessionId, userId, preProcessed) => {
      const deps: CompletionDeps = {
        ...completionDeps,
        singleTurn: true,
        ...(config.scheduler.timeout_sec
          ? { config: { ...config, sandbox: { ...config.sandbox, timeout_sec: config.scheduler.timeout_sec } } }
          : {}),
      };
      return processCompletionForSession(
        content, requestId,
        messages as { role: string; content: string | import('../types.js').ContentBlock[] }[],
        sessionId,
        userId,
        undefined,
        preProcessed,
        deps,
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

    sessionPodManager.shutdown();
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
