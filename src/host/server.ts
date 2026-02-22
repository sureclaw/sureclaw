/**
 * AX Server — composition root.
 *
 * Wires together HTTP handling (server-http.ts), completion processing
 * (server-completions.ts), channel ingestion (server-channels.ts), and
 * lifecycle management (server-lifecycle.ts).
 *
 * Exposes OpenAI-compatible API over Unix socket.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { axHome, dataDir, dataFile, isValidSessionId, agentDir as agentDirPath } from '../paths.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { InboundMessage } from '../providers/channel/types.js';
import { ConversationStore } from '../conversation-store.js';
import { loadProviders } from './registry.js';
import { MessageQueue } from '../db.js';
import { createRouter } from './router.js';
import { createIPCHandler, createIPCServer } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { getLogger } from '../logger.js';
import { SessionStore } from '../session-store.js';
import { resolveDelivery } from './delivery.js';
import { templatesDir as resolveTemplatesDir } from '../utils/assets.js';

// Extracted modules
import { sendError, sendSSEChunk, readBody } from './server-http.js';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from './server-http.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { cleanStaleWorkspaces } from './server-lifecycle.js';
import { ChannelDeduplicator, registerChannelHandler } from './server-channels.js';

// =====================================================
// Types
// =====================================================

export interface ServerOptions {
  socketPath?: string;
  daemon?: boolean;
  verbose?: boolean;
  channels?: import('../providers/channel/types.js').ChannelProvider[];
  dedupeWindowMs?: number;
}

export interface AxServer {
  listening: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// =====================================================
// Helpers
// =====================================================

/** Returns true when the agent is still in bootstrap mode (no SOUL.md yet, BOOTSTRAP.md present). */
export function isAgentBootstrapMode(agentDirPath: string): boolean {
  return !existsSync(join(agentDirPath, 'SOUL.md')) && existsSync(join(agentDirPath, 'BOOTSTRAP.md'));
}

/** Returns true when the given userId appears in the agent's admins file. */
export function isAdmin(agentDirPath: string, userId: string): boolean {
  const adminsPath = join(agentDirPath, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.includes(userId);
}

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

  // Load providers
  logger.info('loading_providers');
  const providers = await loadProviders(config);
  logger.info('providers_loaded');

  // Inject additional channel providers (e.g. for testing)
  if (opts.channels?.length) {
    providers.channels.push(...opts.channels);
  }

  // Initialize DB + Conversation Store + Taint Budget + Router + IPC
  mkdirSync(dataDir(), { recursive: true });
  const db = new MessageQueue(dataFile('messages.db'));
  const conversationStore = new ConversationStore();
  const sessionStore = new SessionStore();
  const taintBudget = new TaintBudget({
    threshold: thresholdForProfile(config.profile),
  });
  const router = createRouter(providers, db, { taintBudget });
  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  mkdirSync(agentDirVal, { recursive: true });

  // Let scheduler know where the agent dir is (for HEARTBEAT.md loading)
  config.scheduler.agent_dir = agentDirVal;

  // First-run: copy default templates into agent dir if files don't already exist
  const templatesDir = resolveTemplatesDir();
  for (const file of ['AGENTS.md', 'BOOTSTRAP.md', 'USER_BOOTSTRAP.md', 'HEARTBEAT.md', 'capabilities.yaml']) {
    const dest = join(agentDirVal, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest);
    }
  }

  // Default user ID for the creating user (used for admin seeding and IPC context)
  const defaultUserId = process.env.USER ?? 'default';

  // Seed admins file on first run so the creating user can bootstrap the agent.
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) {
    writeFileSync(adminsPath, `${defaultUserId}\n`, 'utf-8');
  }

  const handleIPC = createIPCHandler(providers, {
    taintBudget,
    agentDir: agentDirVal,
    agentName,
    profile: config.profile,
    configModel: config.model,
  });

  // IPC socket server (internal agent-to-host socket)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer: NetServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);
  logger.info('ipc_server_started', { socket: ipcSocketPath });

  // Session tracking for canary tokens
  const sessionCanaries = new Map<string, string>();

  // Deduplication
  const deduplicator = new ChannelDeduplicator({
    windowMs: opts.dedupeWindowMs,
  });

  // Model ID for API responses
  const modelId = providers.llm.name;

  // Shared completion dependencies
  const completionDeps: CompletionDeps = {
    config,
    providers,
    db,
    conversationStore,
    router,
    taintBudget,
    sessionCanaries,
    ipcSocketPath,
    ipcSocketDir,
    agentDir: agentDirVal,
    logger,
    verbose: opts.verbose,
  };

  let httpServer: HttpServer | null = null;
  let listening = false;

  // --- Request Handler ---

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? '/';

    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (url === '/v1/models' && req.method === 'GET') {
      handleModels(res);
      return;
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        await handleCompletions(req, res);
      } catch (err) {
        logger.error('request_failed', { error: (err as Error).message });
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error');
        }
      }
      return;
    }

    sendError(res, 404, 'Not found');
  }

  function handleModels(res: ServerResponse): void {
    const body = JSON.stringify({
      object: 'list',
      data: [{ id: modelId, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'ax' }],
    });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);

    // Read and parse body
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
      sendError(res, 400, 'Invalid JSON in request body');
      return;
    }

    if (!chatReq.messages || !Array.isArray(chatReq.messages) || chatReq.messages.length === 0) {
      sendError(res, 400, 'messages array is required and must not be empty');
      return;
    }

    // Validate session_id if provided
    if (chatReq.session_id !== undefined && !isValidSessionId(chatReq.session_id)) {
      sendError(res, 400, 'Invalid session_id: must be a valid UUID or colon-separated session ID (e.g. main:cli:default)');
      return;
    }

    const requestModel = chatReq.model ?? modelId;

    // Extract last user message content
    const lastMsg = chatReq.messages[chatReq.messages.length - 1];
    const content = lastMsg?.content ?? '';

    // Process completion
    const { responseContent, finishReason } = await processCompletion(
      completionDeps, content, requestId, chatReq.messages, chatReq.session_id,
    );

    if (chatReq.stream) {
      // Streaming mode -- SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
      });

      // Role chunk
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      // Content chunk
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: { content: responseContent }, finish_reason: null }],
      });

      // Finish chunk
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // Non-streaming mode
      const response: OpenAIChatResponse = {
        id: requestId, object: 'chat.completion', created, model: requestModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: responseContent },
          finish_reason: finishReason,
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };

      const responseBody = JSON.stringify(response);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(responseBody) });
      res.end(responseBody);
    }
  }

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
        logger.info('server_listening', { socket: socketPath });
        resolveP();
      });
      httpServer!.on('error', rejectP);
    });

    // Start scheduler
    await providers.scheduler.start(async (msg: InboundMessage) => {
      const result = await router.processInbound(msg);
      if (result.queued) {
        sessionCanaries.set(result.sessionId, result.canaryToken);
        const { responseContent } = await processCompletion(
          completionDeps, msg.content, `sched-${randomUUID().slice(0, 8)}`, [], undefined,
          { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
        );

        // Resolve delivery target and send if applicable
        if (responseContent.trim()) {
          let delivery: import('../providers/scheduler/types.js').CronDelivery | undefined;
          let jobAgentId = agentName;

          if (msg.sender.startsWith('cron:')) {
            const jobId = msg.sender.slice(5);
            const jobs = providers.scheduler.listJobs?.() ?? [];
            const job = jobs.find(j => j.id === jobId);
            if (job) {
              jobAgentId = job.agentId;
              delivery = job.delivery ?? config.scheduler.defaultDelivery;
            } else {
              // Job may have been auto-deleted (runOnce) — use default delivery
              delivery = config.scheduler.defaultDelivery;
            }
          } else if (msg.sender === 'heartbeat') {
            delivery = config.scheduler.defaultDelivery;
          } else {
            // hint or other scheduler message — use default
            delivery = config.scheduler.defaultDelivery;
          }

          const resolution = resolveDelivery(delivery, {
            sessionStore,
            agentId: jobAgentId,
            defaultDelivery: config.scheduler.defaultDelivery,
            channels: providers.channels,
          });

          if (resolution.mode === 'channel' && resolution.session && resolution.channelProvider) {
            const outbound = await router.processOutbound(responseContent, result.sessionId, result.canaryToken);
            if (!outbound.canaryLeaked) {
              try {
                await resolution.channelProvider.send(resolution.session, { content: outbound.content });
                logger.info('cron_delivered', {
                  sender: msg.sender,
                  provider: resolution.session.provider,
                  contentLength: outbound.content.length,
                });
              } catch (err) {
                logger.error('cron_delivery_failed', {
                  sender: msg.sender,
                  provider: resolution.session.provider,
                  error: (err as Error).message,
                });
              }
            } else {
              logger.warn('cron_delivery_canary_leaked', { sender: msg.sender });
            }
          }
        }

        logger.info('scheduler_message_processed', {
          contentLength: responseContent.length,
        });
      }
    });

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
        isAgentBootstrapMode,
        isAdmin,
      });
      await channel.connect();
    }
  }

  let stopped = false;

  async function stopServer(): Promise<void> {
    if (stopped) return;
    stopped = true;

    // Disconnect channels
    for (const channel of providers.channels) {
      await channel.disconnect();
    }

    // Stop scheduler
    await providers.scheduler.stop();

    // Stop HTTP server
    if (httpServer) {
      await new Promise<void>((resolveP) => {
        httpServer!.close(() => resolveP());
      });
      httpServer = null;
    }

    // Stop IPC server
    try { ipcServer.close(); } catch {
      logger.debug('ipc_server_close_failed');
    }

    // Close DBs
    try { db.close(); } catch {
      logger.debug('db_close_failed');
    }
    try { conversationStore.close(); } catch {
      logger.debug('conversation_store_close_failed');
    }
    try { sessionStore.close(); } catch {
      logger.debug('session_store_close_failed');
    }

    // Clean up sockets
    try { unlinkSync(socketPath); } catch {
      logger.debug('socket_cleanup_failed', { socketPath });
    }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch {
      logger.debug('ipc_dir_cleanup_failed', { ipcSocketDir });
    }

    listening = false;
  }

  return {
    get listening() { return listening; },
    start: startServer,
    stop: stopServer,
  };
}
