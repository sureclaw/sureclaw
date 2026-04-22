/**
 * AX Server — unified composition root for both local and k8s deployment.
 *
 * Wires together HTTP handling (server-http.ts), completion processing
 * (server-completions.ts), channel ingestion (server-channels.ts), and
 * lifecycle management (server-lifecycle.ts).
 *
 * Transport listeners (config-driven):
 *   Local: Unix socket (~/.ax/ax.sock) + optional TCP port
 *   K8s: TCP on 0.0.0.0:PORT
 *
 * Internal routes (/internal/ipc, /internal/work, /internal/llm-proxy)
 * are registered in k8s mode for HTTP-based IPC from sandbox pods.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { axHome } from '../paths.js';
import type { Config } from '../types.js';
import { loadProviders } from './registry.js';
import { getLogger } from '../logger.js';
import type { EventBus } from './event-bus.js';
import { attachEventConsole, attachJsonEventConsole } from './event-console.js';

// Extracted modules
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { ChannelDeduplicator, registerChannelHandler, connectChannelWithRetry, ThreadOwnershipMap } from './server-channels.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';

// Shared extraction modules
import { initHostCore } from './server-init.js';
import {
  createRequestHandler,
  createSchedulerCallback,
} from './server-request-handlers.js';
import { setupWebhookHandler, setupAdminHandler } from './server-webhook-admin.js';
import { isAgentBootstrapMode, isAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';
import { createSessionManager, type SessionManager } from './session-manager.js';
import { sendError, readBody } from './server-http.js';
import type { IPCContext } from './ipc-server.js';
import { dataDir } from '../paths.js';
import { startWebProxy, type WebProxy } from './web-proxy.js';
import { SharedCredentialRegistry } from './credential-placeholders.js';
import { BUILTIN_DOMAINS, normalizeDomain } from './skills/domain-allowlist.js';

// Git-native skills: post-receive hook mount (cache-bust).
import { createReconcileHookHandler } from './skills/hook-endpoint.js';

/**
 * Token registry: maps per-turn tokens to their bound IPC handler + context.
 * Used by /internal/ipc, /internal/work, and /internal/llm-proxy HTTP routes (k8s mode).
 */
export const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
}>();

// =====================================================
// Types
// =====================================================

export interface ServerOptions {
  socketPath?: string;
  port?: number;
  daemon?: boolean;
  verbose?: boolean;
  json?: boolean;
  channels?: import('../providers/channel/types.js').ChannelProvider[];
  dedupeWindowMs?: number;
  /** Override specific providers at load time (test/debug only). */
  providerOverrides?: Partial<import('../types.js').ProviderRegistry>;
}

export interface AxServer {
  listening: boolean;
  /** TCP address when --port is used (null otherwise). */
  tcpAddress: { host: string; port: number } | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// =====================================================
// Helpers (re-exported from server-admin-helpers.ts)
// =====================================================

export { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin, type AdminContext } from './server-admin-helpers.js';

// =====================================================
// Server Factory
// =====================================================

export async function createServer(
  config: Config,
  opts: ServerOptions = {},
): Promise<AxServer> {
  const socketPath = opts.socketPath ?? `${axHome()}/ax.sock`;

  // Use the singleton logger
  const logger = getLogger();

  // Initialize OpenTelemetry tracing (no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset)
  await initTracing();

  // Load providers (credential provider is loaded first inside loadProviders
  // so process.env is seeded before channel providers read tokens).
  logger.debug('loading_providers');
  const providers = await loadProviders(config, { providerOverrides: opts.providerOverrides });
  logger.debug('providers_loaded');

  // Use the eventbus provider (loaded by registry alongside other providers).
  const eventBus: EventBus = providers.eventbus;

  const usePrettyEvents = (process.stdout.isTTY ?? false) && !opts.verbose && !opts.json;
  if (usePrettyEvents) {
    attachEventConsole(eventBus);
  } else if (opts.json || !process.stdout.isTTY) {
    attachJsonEventConsole(eventBus);
  }

  eventBus.emit({ type: 'server.config', requestId: 'system', timestamp: Date.now(),
    data: { profile: config.profile } });
  eventBus.emit({ type: 'server.providers', requestId: 'system', timestamp: Date.now(), data: {} });

  // Inject additional channel providers (e.g. for testing)
  if (opts.channels?.length) {
    providers.channels.push(...opts.channels);
  }

  // ── Shared initialization (storage, routing, IPC, templates, orchestrator) ──
  const core = await initHostCore({ config, providers, eventBus, verbose: opts.verbose });
  const {
    completionDeps, conversationStore, sessionStore, router, taintBudget, fileStore, gcsFileStorage,
    handleIPC, ipcServer, ipcSocketDir, orchestrator, disableAutoState,
    agentRegistry, agentId: agentName, adminCtx, sessionCanaries,
    defaultUserId, modelId, skillCredStore, skillDomainStore,
    agentSkillsDeps,
  } = core;

  const isK8s = config.providers.sandbox === 'k8s';

  // ── Git-native skills: post-receive hook (cache-bust) ──
  //
  // The per-agent git post-receive hook POSTs to `/v1/internal/skills/reconcile`
  // after every ref move. The handler HMAC-verifies the payload and drops the
  // agent's cached snapshots so the next live read walks git afresh.
  let reconcileHookHandler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined;

  if (agentSkillsDeps) {
    // AX_HOOK_SECRET: shared HMAC secret for post-receive → host handshake.
    // Env-var preferred so the hook installer can read the same value; fall
    // back to a random per-process secret with a loud warning when unset.
    // Stash on process.env so the hook installer picks it up without
    // re-plumbing.
    let hookSecret = process.env.AX_HOOK_SECRET;
    if (!hookSecret) {
      hookSecret = randomBytes(32).toString('hex');
      process.env.AX_HOOK_SECRET = hookSecret;
      logger.warn('ax_hook_secret_generated', {
        message: 'AX_HOOK_SECRET env var unset — generated a random secret for this process. Git-push reconcile hooks across restarts require a stable secret.',
      });
    }

    reconcileHookHandler = createReconcileHookHandler({
      secret: hookSecret,
      snapshotCache: agentSkillsDeps.snapshotCache,
      agentSkillsDeps,
    });
  } else {
    logger.debug('skills_reconcile_hook_disabled_no_database');
  }

  // ── Session manager (tracks session-long sandboxes across turns) ──
  const sessionManager = createSessionManager({
    idleTimeoutMs: (config.sandbox?.idle_timeout_sec ?? 300) * 1000,
    cleanIdleTimeoutMs: (config.sandbox?.clean_idle_timeout_sec ?? 300) * 1000,
    warningLeadMs: 120_000,
    onKill: (sessionId, entry) => {
      logger.info('session_killed', { sessionId });
      // Clean up reusable workspace/gitDir when session is torn down
      if (entry.workspace) {
        try { rmSync(entry.workspace, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (entry.gitDir) {
        try { rmSync(entry.gitDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    },
  });

  // ── Shared credential registry (k8s shared MITM proxy needs cross-session lookup) ──
  const sharedCredentialRegistry = isK8s ? new SharedCredentialRegistry() : undefined;
  if (sharedCredentialRegistry) {
    completionDeps.sharedCredentialRegistry = sharedCredentialRegistry;
  }

  // ── Shared web proxy (k8s: TCP port for all pods; local: per-session in processCompletion) ──
  let webProxy: WebProxy | undefined;
  if (isK8s && config.web_proxy) {
    const webProxyPort = parseInt(process.env.AX_PROXY_LISTEN_PORT ?? '3128', 10);
    const { getOrCreateCA } = await import('./proxy-ca.js');
    const caDir = join(dataDir(), 'ca');
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
      // Host-process proxy only handles infrastructure traffic (admin dashboard
      // callouts, host-side fetches). Agent traffic runs through per-session
      // proxies with per-agent allowlists. BUILTIN_DOMAINS covers package
      // managers + GitHub — anything else gets denied at the proxy boundary.
      allowedDomains: { has: (d: string) => BUILTIN_DOMAINS.has(normalizeDomain(d)) },
      mitm: {
        ca,
        credentials: sharedCredentialRegistry!,
        bypassDomains: new Set(config.mitm_bypass_domains ?? []),
      },
      urlRewrites: config.url_rewrites
        ? new Map(Object.entries(config.url_rewrites))
        : undefined,
    });
    logger.info('web_proxy_started', { port: webProxyPort, mitm: true });
  }

  // ── Deduplication ──
  const deduplicator = new ChannelDeduplicator({
    windowMs: opts.dedupeWindowMs,
  });

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
      const childConfig: Config = {
        ...config,
        ...(result.agentId ? { agent_name: result.agentId } : {}),
        ...(result.model ? { models: { default: [result.model] } } : {}),
        ...(result.timeoutSec ? { sandbox: { ...config.sandbox, timeout_sec: result.timeoutSec } } : {}),
      };
      const childDeps: CompletionDeps = { ...completionDeps, config: childConfig };
      void processCompletion(
        childDeps,
        result.message,
        runId,
        [],
        undefined,
        undefined,
        'webhook',
      ).catch(err => {
        logger.error('webhook_dispatch_failed', { runId, error: (err as Error).message });
      });
    },
  });

  // ── Admin handler ──
  const startTime = Date.now();
  const bindHost = process.env.BIND_HOST ?? '127.0.0.1';
  const localDevMode = bindHost === '127.0.0.1' || bindHost === '::1';
  const adminHandler = setupAdminHandler({
    config,
    providers,
    eventBus,
    agentRegistry,
    startTime,
    localDevMode,
    mcpManager: core.mcpManager,
    externalAuth: !!providers.auth?.length,
    skillCredStore,
    skillDomainStore,
    agentSkillsDeps,
    defaultUserId,
    resolveAuthenticatedUser: providers.auth?.length
      ? async (req) => {
          const { authenticateRequest } = await import('./server-request-handlers.js');
          const result = await authenticateRequest(req, providers.auth!);
          return result.authenticated && result.user
            ? { id: result.user.id, email: result.user.email }
            : undefined;
        }
      : undefined,
    adminOAuthProviderStore: core.adminOAuthProviderStore,
    adminOAuthFlow: core.adminOAuthFlow,
  });

  let httpServer: HttpServer | null = null;
  let tcpServer: HttpServer | null = null;
  let listening = false;
  let draining = false;

  // In-flight request tracking for graceful shutdown
  let inflightCount = 0;
  let drainResolve: (() => void) | null = null;
  const DRAIN_TIMEOUT_MS = 30_000;

  function trackRequestStart(): void { inflightCount++; }
  function trackRequestEnd(): void {
    inflightCount--;
    if (draining && inflightCount <= 0 && drainResolve) {
      drainResolve();
    }
  }

  function waitForDrain(): Promise<void> {
    if (inflightCount <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainResolve = resolve;
      setTimeout(() => {
        if (inflightCount > 0) {
          logger.warn('drain_timeout', { inflight: inflightCount, timeoutMs: DRAIN_TIMEOUT_MS });
        }
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
  }

  // ── processCompletion wrapper (k8s: per-turn tokens + session manager) ──

  const agentType = config.agent ?? 'pi-coding-agent';
  const DIRTY_ACTIONS = new Set(['sandbox_bash', 'sandbox_write_file', 'sandbox_edit_file']);

  async function processCompletionForSession(
    content: string | import('../types.js').ContentBlock[],
    requestId: string,
    messages: { role: string; content: string | import('../types.js').ContentBlock[] }[],
    sessionId: string,
    userId?: string,
    _agentType?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
    baseDeps?: CompletionDeps,
  ): Promise<{
    responseContent: string;
    finishReason: 'stop' | 'content_filter';
    contentBlocks?: import('../types.js').ContentBlock[];
    diagnostics?: readonly import('./diagnostics.js').Diagnostic[];
  }> {
    const turnToken = randomUUID();

    // Set up agent_response interceptor
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

    // Wrap handleIPC to intercept agent_response and mark session dirty
    const wrappedHandleIPC = isK8s
      ? async (raw: string, ctx: IPCContext): Promise<string> => {
          try {
            const parsed = JSON.parse(raw);
            if (parsed.action === 'agent_response') {
              agentResponseResolve?.(parsed.content ?? '');
              return JSON.stringify({ ok: true });
            }
            if (parsed.action && DIRTY_ACTIONS.has(parsed.action)) {
              sessionManager.markDirty(sessionId);
            }
          } catch { /* fall through */ }
          return handleIPC(raw, ctx);
        }
      : handleIPC;

    // Register turn token for HTTP IPC route
    if (isK8s) {
      activeTokens.set(turnToken, {
        handleIPC: wrappedHandleIPC,
        ctx: { sessionId, agentId: baseDeps?.config.agent_name ?? agentName, userId: userId ?? defaultUserId, requestId },
      });
    }

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

    const turnDeps: CompletionDeps = {
      ...(baseDeps ?? completionDeps),
      sessionManager,
      extraSandboxEnv: isK8s ? {
        AX_IPC_TOKEN: turnToken,
        AX_IPC_REQUEST_ID: requestId,
        AX_HOST_URL: `http://ax-host.${config.namespace ?? 'ax'}.svc`,
        ...(config.web_proxy ? { AX_WEB_PROXY_URL: `http://ax-web-proxy.${config.namespace ?? 'ax'}.svc:3128` } : {}),
      } : undefined,
      ...(agentResponsePromise ? { agentResponsePromise } : {}),
      ...(startAgentResponseTimer ? { startAgentResponseTimer } : {}),
      // Keep the token's IPC ctx in sync when processCompletion rewrites the
      // `:_:` placeholder in sessionId. Without this, `/internal/ipc` callers
      // that don't stamp `_sessionId` read the stale pre-rewrite sessionId and
      // miss the per-turn catalog/workspace maps keyed on the rewritten form.
      ...(isK8s ? {
        updateTurnCtx: (updates: { sessionId?: string; agentId?: string }) => {
          const entry = activeTokens.get(turnToken);
          if (!entry) return;
          entry.ctx = {
            ...entry.ctx,
            ...(updates.sessionId !== undefined ? { sessionId: updates.sessionId } : {}),
            ...(updates.agentId !== undefined ? { agentId: updates.agentId } : {}),
          };
        },
      } : {}),
    };

    const sessionStartTime = Date.now();
    try {
      const result = await processCompletion(
        turnDeps, content, requestId, messages, sessionId, preProcessed, userId,
      );
      logger.debug('session_completed', {
        requestId, sessionId,
        responseLength: result.responseContent.length,
        finishReason: result.finishReason,
        durationMs: Date.now() - sessionStartTime,
      });
      return result;
    } finally {
      if (agentTimer) clearTimeout(agentTimer);
      activeTokens.delete(turnToken);
      if (sessionManager.has(sessionId)) {
        sessionManager.touch(sessionId);
      }
    }
  }

  // ── k8s internal HTTP routes ──

  async function handleInternalRoutes(req: IncomingMessage, res: ServerResponse, url: string): Promise<boolean> {
    // Git-native skills reconcile hook — works in ALL deployment modes (not
    // just k8s). Auth is per-request HMAC, not turn-token.
    if (url === '/v1/internal/skills/reconcile' && req.method === 'POST') {
      if (!reconcileHookHandler) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Reconcile hook unavailable: no database provider configured' }));
        return true;
      }
      await reconcileHookHandler(req, res);
      return true;
    }

    if (!isK8s) return false;

    // LLM proxy over HTTP from sandbox pods
    if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
      const token = req.headers['x-api-key'] as string;
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid token' })); return true; }
      try {
        const targetPath = url.replace('/internal/llm-proxy', '');
        const body = await readBody(req, 10_485_760);
        const { forwardLLMRequest } = await import('./llm-proxy-core.js');
        await forwardLLMRequest({ targetPath, body: body.toString(), incomingHeaders: req.headers, res });
      } catch (err) {
        logger.error('internal_llm_proxy_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 502, 'LLM proxy request failed');
      }
      return true;
    }

    // Pod work fetch
    if (url === '/internal/work' && req.method === 'GET') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      if (!token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'missing token' })); return true; }
      const sid = sessionManager.findSessionByToken(token);
      const work = sid ? sessionManager.claimWork(sid) : undefined;
      if (!work) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no pending work for token' })); return true; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(work);
      return true;
    }

    // IPC over HTTP from sandbox pods
    if (url === '/internal/ipc' && req.method === 'POST') {
      const token = req.headers.authorization?.replace('Bearer ', '');
      const entry = token ? activeTokens.get(token) : undefined;
      if (!entry) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid token' })); return true; }
      try {
        const body = await readBody(req, 1_048_576);
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

  // --- Request Handler (via shared factory) ---

  const handleRequest = createRequestHandler({
    modelId,
    agentName,
    adminCtx,
    eventBus,
    providers,
    fileStore,
    gcsFileStorage,
    taintBudget,
    completionOpts: {
      modelId,
      agentName,
      adminCtx,
      eventBus,
      runCompletion: async (content, requestId, messages, sessionId, userId) => {
        return processCompletionForSession(content, requestId, messages, sessionId, userId, agentType);
      },
      preFlightCheck: async (_sessionId: string, userId: string | undefined) => {
        if (userId && await isAgentBootstrapMode(core.adminCtx)) {
          if (!(await isAdmin(core.adminCtx, userId))) {
            const claimed = await claimBootstrapAdmin(core.adminCtx, userId);
            if (claimed) {
              logger.info('bootstrap_admin_claimed', { provider: 'http', sender: userId });
              return undefined;
            }
            return 'This agent is still being set up. Only admins can interact during bootstrap.';
          }
        }
        return undefined;
      },
    },
    webhookPrefix,
    webhookHandler,
    adminHandler,
    adminOAuthFlow: core.adminOAuthFlow,
    skillCredStore: core.skillCredStore,
    snapshotCache: agentSkillsDeps.snapshotCache,
    authProviders: providers.auth,
    isDraining: () => draining,
    trackRequestStart,
    trackRequestEnd,
    extraRoutes: handleInternalRoutes,
  });

  // --- Lifecycle ---

  async function startServer(): Promise<void> {
    // Remove stale socket
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    httpServer = createHttpServer(handleRequest);

    await new Promise<void>((resolveP, rejectP) => {
      httpServer!.listen(socketPath, () => {
        listening = true;
        logger.debug('server_listening', { socket: socketPath });
        resolveP();
      });
      httpServer!.on('error', rejectP);
    });

    // Listen on a TCP port: explicit --port, or auto-bind for admin dashboard
    const tcpPort = opts.port ?? (config.admin.enabled ? config.admin.port : undefined);
    let tcpBound = false;
    if (tcpPort != null) {
      tcpServer = createHttpServer(handleRequest);
      try {
        await new Promise<void>((resolveP, rejectP) => {
          tcpServer!.listen(tcpPort, process.env.BIND_HOST ?? '127.0.0.1', () => {
            logger.debug('server_listening_tcp', { port: tcpPort });
            tcpBound = true;
            resolveP();
          });
          tcpServer!.on('error', (err) => {
            // If this is an auto-bind for admin (not explicit --port), swallow port conflicts
            if (opts.port == null && (err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
              logger.warn('admin_port_in_use', { port: tcpPort, message: 'Admin dashboard port in use, skipping TCP listener' });
              tcpServer = null;
              resolveP();
            } else {
              rejectP(err);
            }
          });
        });
      } catch (err) {
        if (opts.port != null) throw err;
        logger.warn('tcp_bind_failed', { port: tcpPort, error: (err as Error).message });
        tcpServer = null;
      }
    }

    eventBus.emit({ type: 'server.ready', requestId: 'system', timestamp: Date.now(),
      data: {
        socket: socketPath,
        ...(tcpBound ? { port: tcpPort } : {}),
        ...(adminHandler && tcpBound ? { admin: localDevMode ? `http://127.0.0.1:${tcpPort}/admin` : `http://127.0.0.1:${tcpPort}/admin?token=${config.admin.token}` } : {}),
      } });

    // Start scheduler
    const schedulerCallback = createSchedulerCallback({
      config,
      router,
      sessionCanaries,
      sessionStore,
      agentName,
      channels: providers.channels,
      scheduler: providers.scheduler,
      isBootstrapMode: () => isAgentBootstrapMode(adminCtx),
      runCompletion: async (content, requestId, messages, sessionId, userId, preProcessed, agentId) => {
        const schedConfig = {
          ...config,
          ...(config.scheduler.timeout_sec ? { sandbox: { ...config.sandbox, timeout_sec: config.scheduler.timeout_sec } } : {}),
          ...(agentId ? { agent_name: agentId } : {}),
        };
        const deps: CompletionDeps = { ...completionDeps, config: schedConfig, singleTurn: true };
        return processCompletionForSession(
          content, requestId,
          messages as { role: string; content: string | import('../types.js').ContentBlock[] }[],
          sessionId, userId, undefined, preProcessed, deps,
        );
      },
    });
    await providers.scheduler.start(schedulerCallback);

    // ── Shared thread ownership tracker (all channels share this) ──
    const threadOwners = new ThreadOwnershipMap();

    // Connect channel providers (Slack, Discord, etc.) — default channels
    for (const channel of providers.channels) {
      registerChannelHandler(channel, {
        completionDeps,
        conversationStore,
        sessionStore,
        sessionCanaries,
        router,
        agentName,
        adminCtx,
        deduplicator,
        logger,
        provisioner: core.provisioner,
        agentRegistry: core.agentRegistry,
        threadOwners,
      });
      await connectChannelWithRetry(channel, logger);
    }

    // ── Shared agent startup ──
    if (config.shared_agents?.length) {
      for (const sa of config.shared_agents) {
        try {
          // Resolve tokens from env vars
          const botTokenEnv = sa.slack_bot_token_env ?? `${sa.id.toUpperCase().replace(/-/g, '_')}_SLACK_BOT_TOKEN`;
          const appTokenEnv = sa.slack_app_token_env ?? `${sa.id.toUpperCase().replace(/-/g, '_')}_SLACK_APP_TOKEN`;
          const botToken = process.env[botTokenEnv];
          const appToken = process.env[appTokenEnv];

          if (!botToken || !appToken) {
            logger.warn('shared_agent_skip_no_tokens', {
              agentId: sa.id,
              botTokenEnv,
              appTokenEnv,
              reason: 'Missing Slack tokens — skipping shared agent',
            });
            continue;
          }

          // Register (or update) shared agent in registry
          const entry = await core.agentRegistry.get(sa.id);
          if (!entry) {
            await core.agentRegistry.register({
              id: sa.id,
              name: sa.display_name,
              description: sa.description,
              status: 'active',
              parentId: null,
              agentType: sa.agent ?? config.agent ?? 'pi-coding-agent',
              capabilities: sa.capabilities ?? [],
              createdBy: 'system',
              admins: sa.admins ?? [],
              displayName: sa.display_name,
              agentKind: 'shared',
            });
          }

          // Create Slack provider with injected tokens
          const { createWithTokens } = await import('../providers/channel/slack.js');
          const slackChannel = await createWithTokens(config, { botToken, appToken }, `slack:${sa.id}`);

          // Shared agent admin context
          const saAdminCtx = { ...adminCtx, agentId: sa.id };

          // Register channel handler bound to this shared agent
          registerChannelHandler(slackChannel, {
            completionDeps,
            conversationStore,
            sessionStore,
            sessionCanaries,
            router,
            agentName: sa.id,
            adminCtx: saAdminCtx,
            deduplicator,
            logger,
            provisioner: core.provisioner,
            agentRegistry: core.agentRegistry,
            threadOwners,
            boundAgentId: sa.id,
          });

          await connectChannelWithRetry(slackChannel, logger);
          logger.info('shared_agent_started', { agentId: sa.id, displayName: sa.display_name });
        } catch (err) {
          logger.error('shared_agent_startup_failed', {
            agentId: sa.id,
            error: (err as Error).message,
          });
        }
      }
    }
  }

  let stopped = false;

  async function stopServer(): Promise<void> {
    if (stopped) return;
    stopped = true;

    // Enter draining mode: reject new requests but let in-flight ones finish
    draining = true;
    if (inflightCount > 0) {
      logger.info('graceful_drain_start', { inflight: inflightCount });
      await waitForDrain();
      logger.info('graceful_drain_complete');
    }

    // Disconnect channels
    for (const channel of providers.channels) {
      await channel.disconnect();
    }

    // Stop scheduler
    await providers.scheduler.stop();

    // Stop TCP server
    if (tcpServer) {
      await new Promise<void>((resolveP) => {
        tcpServer!.close(() => resolveP());
      });
      tcpServer = null;
    }

    // Stop HTTP server (Unix socket)
    if (httpServer) {
      await new Promise<void>((resolveP) => {
        httpServer!.close(() => resolveP());
      });
      httpServer = null;
    }

    // Stop orchestrator (disableAutoState first to unsubscribe event listener)
    disableAutoState();
    orchestrator.shutdown();

    // Stop session manager and web proxy
    sessionManager.shutdown();
    if (webProxy) webProxy.stop();

    // Stop IPC server
    try { ipcServer.close(); } catch {
      logger.debug('ipc_server_close_failed');
    }

    // Close event bus provider
    try { providers.eventbus.close(); } catch {
      logger.debug('eventbus_close_failed');
    }

    // Close DBs — storage provider handles messages, conversations, sessions
    try { providers.storage.close(); } catch {
      logger.debug('storage_close_failed');
    }
    try { await fileStore.close(); } catch {
      logger.debug('file_store_close_failed');
    }
    try { await gcsFileStorage?.close(); } catch {
      logger.debug('gcs_file_storage_close_failed');
    }

    // Flush and shut down OTel tracing
    await shutdownTracing();

    // Clean up sockets
    try { unlinkSync(socketPath); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.debug('socket_cleanup_failed', { socketPath, error: (err as Error).message });
      }
    }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch {
      logger.debug('ipc_dir_cleanup_failed', { ipcSocketDir });
    }

    listening = false;
  }

  return {
    get listening() { return listening; },
    get tcpAddress() {
      if (!tcpServer) return null;
      const addr = tcpServer.address();
      if (!addr || typeof addr === 'string') return null;
      return { host: addr.address, port: addr.port };
    },
    start: startServer,
    stop: stopServer,
  };
}
