/**
 * AX Server — composition root.
 *
 * Wires together HTTP handling (server-http.ts), completion processing
 * (server-completions.ts), channel ingestion (server-channels.ts), and
 * lifecycle management (server-lifecycle.ts).
 *
 * Exposes OpenAI-compatible API over Unix socket (and optionally TCP).
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { existsSync, copyFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { axHome, agentIdentityDir } from '../paths.js';
import type { Config } from '../types.js';
import { loadProviders } from './registry.js';
import { getLogger } from '../logger.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';
import type { EventBus } from './event-bus.js';
import { attachEventConsole, attachJsonEventConsole } from './event-console.js';

// Extracted modules
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { cleanStaleWorkspaces } from './server-lifecycle.js';
import { ChannelDeduplicator, registerChannelHandler, connectChannelWithRetry } from './server-channels.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';

// Shared extraction modules
import { initHostCore } from './server-init.js';
import {
  createRequestHandler,
  createSchedulerCallback,
} from './server-request-handlers.js';
import { setupWebhookHandler, setupAdminHandler } from './server-webhook-admin.js';

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

import { isAgentBootstrapMode, isAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';
export { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin } from './server-admin-helpers.js';

// =====================================================
// Server Factory
// =====================================================

export async function createServer(
  config: Config,
  opts: ServerOptions = {},
): Promise<AxServer> {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');

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
    completionDeps, conversationStore, sessionStore, router, taintBudget, fileStore,
    ipcServer, ipcSocketDir, orchestrator, disableAutoState,
    agentRegistry, agentName, agentDirVal, identityFilesDir, sessionCanaries,
    modelId,
  } = core;

  // ── Legacy migration (server.ts-only): move files from flat layout to subdirectories ──
  const agentConfigDir = agentIdentityDir(agentName);
  const legacyIdentityFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'HEARTBEAT.md'];
  for (const file of legacyIdentityFiles) {
    const legacySrc = join(agentDirVal, file);
    const newDest = join(identityFilesDir, file);
    if (existsSync(legacySrc) && !existsSync(newDest)) {
      renameSync(legacySrc, newDest);
    }
  }
  const legacyConfigFiles = ['BOOTSTRAP.md', 'USER_BOOTSTRAP.md', 'capabilities.yaml'];
  for (const file of legacyConfigFiles) {
    const legacySrc = join(agentDirVal, file);
    const newDest = join(agentConfigDir, file);
    if (existsSync(legacySrc) && !existsSync(newDest)) {
      renameSync(legacySrc, newDest);
    }
  }
  // Cleanup: USER_BOOTSTRAP.md should NOT be in identityFilesDir (it's passed via stdin).
  try {
    unlinkSync(join(identityFilesDir, 'USER_BOOTSTRAP.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.debug('user_bootstrap_cleanup_failed', { error: (err as Error).message });
    }
  }

  // USER_BOOTSTRAP.md → agentConfigDir (filesystem copy, server.ts-specific)
  {
    const templatesDir = resolveTemplatesDir();
    const src = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(src)) {
      const configDest = join(agentConfigDir, 'USER_BOOTSTRAP.md');
      if (!existsSync(configDest)) copyFileSync(src, configDest);
    }
  }

  // ── Deduplication (server.ts-only) ──
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
  const adminHandler = setupAdminHandler({
    config,
    providers,
    eventBus,
    agentRegistry,
    startTime,
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

  // --- Request Handler (via shared factory) ---

  const handleRequest = createRequestHandler({
    modelId,
    agentName,
    agentDirVal,
    eventBus,
    providers,
    fileStore,
    taintBudget,
    completionOpts: {
      modelId,
      agentName,
      agentDirVal,
      eventBus,
      runCompletion: async (content, requestId, messages, sessionId, userId) => {
        return processCompletion(completionDeps, content, requestId, messages, sessionId, undefined, userId);
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
  });

  // --- Lifecycle ---

  async function startServer(): Promise<void> {
    // Clean up stale persistent workspaces (older than 7 days)
    cleanStaleWorkspaces(logger);

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
        ...(adminHandler && tcpBound ? { admin: `http://127.0.0.1:${tcpPort}/admin?token=${config.admin.token}` } : {}),
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
      runCompletion: async (content, requestId, messages, sessionId, userId, preProcessed) => {
        return processCompletion(completionDeps, content, requestId, messages, sessionId, preProcessed, userId);
      },
    });
    await providers.scheduler.start(schedulerCallback);

    // Connect channel providers (Slack, Discord, etc.)
    for (const channel of providers.channels) {
      registerChannelHandler(channel, {
        completionDeps,
        conversationStore,
        sessionStore,
        sessionCanaries,
        router,
        agentName,
        agentDir: agentDirVal,
        deduplicator,
        logger,
        isAgentBootstrapMode: (name: string) => isAgentBootstrapMode(name),
        isAdmin,
        claimBootstrapAdmin,
      });
      await connectChannelWithRetry(channel, logger);
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
