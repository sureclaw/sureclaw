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
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { axHome, dataDir, dataFile, isValidSessionId, agentDir as agentDirPath, agentIdentityDir, agentIdentityFilesDir, agentSkillsDir } from '../paths.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { InboundMessage } from '../providers/channel/types.js';
import { ConversationStore } from '../conversation-store.js';
import { loadProviders } from './registry.js';
import { MessageQueue } from '../db.js';
import { createRouter } from './router.js';
import { createIPCHandler, createIPCServer, type DelegateRequest, type IPCContext } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { getLogger } from '../logger.js';
import { SessionStore } from '../session-store.js';
import { resolveDelivery } from './delivery.js';
import { templatesDir as resolveTemplatesDir, seedSkillsDir as resolveSeedSkillsDir } from '../utils/assets.js';
import { createEventBus, type EventBus } from './event-bus.js';
import { attachEventConsole, attachJsonEventConsole } from './event-console.js';
import { createOrchestrator, type Orchestrator } from './orchestration/orchestrator.js';

// Extracted modules
import { sendError, sendSSEChunk, readBody } from './server-http.js';
import type { OpenAIChatRequest, OpenAIChatResponse, OpenAIStreamChunk } from './server-http.js';
import { processCompletion, type CompletionDeps } from './server-completions.js';
import { cleanStaleWorkspaces } from './server-lifecycle.js';
import { ChannelDeduplicator, registerChannelHandler, connectChannelWithRetry } from './server-channels.js';
import { initTracing, shutdownTracing } from '../utils/tracing.js';
import { handleFileUpload, handleFileDownload } from './server-files.js';
import { FileStore } from '../file-store.js';

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
}

export interface AxServer {
  listening: boolean;
  /** TCP address when --port is used (null otherwise). */
  tcpAddress: { host: string; port: number } | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// =====================================================
// Helpers
// =====================================================

/** Returns true when the agent is still in bootstrap mode (missing SOUL.md or IDENTITY.md while BOOTSTRAP.md present). */
export function isAgentBootstrapMode(agentName: string): boolean {
  const configDir = agentIdentityDir(agentName);
  const idFilesDir = agentIdentityFilesDir(agentName);
  if (!existsSync(join(configDir, 'BOOTSTRAP.md'))) return false;
  return !existsSync(join(idFilesDir, 'SOUL.md')) || !existsSync(join(idFilesDir, 'IDENTITY.md'));
}

/** Returns true when the given userId appears in the agent's admins file. */
export function isAdmin(agentDirPath: string, userId: string): boolean {
  const adminsPath = join(agentDirPath, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.includes(userId);
}

/** Appends a userId to the agent's admins file. */
export function addAdmin(agentDirPath: string, userId: string): void {
  const adminsPath = join(agentDirPath, 'admins');
  appendFileSync(adminsPath, `${userId}\n`, 'utf-8');
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim (and is added to admins).
 * Returns false if someone already claimed it.
 * The 'wx' flag (O_EXCL) ensures only one caller wins the race.
 */
export function claimBootstrapAdmin(agentDirPath: string, userId: string): boolean {
  const claimPath = join(agentDirPath, '.bootstrap-admin-claimed');

  // If the claim file exists but the claimed user is no longer in admins
  // (e.g. admins was reset to re-bootstrap), remove the stale claim.
  if (existsSync(claimPath)) {
    const claimedUser = readFileSync(claimPath, 'utf-8').trim();
    if (!isAdmin(agentDirPath, claimedUser)) {
      unlinkSync(claimPath);
    }
  }

  try {
    writeFileSync(claimPath, userId, { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  addAdmin(agentDirPath, userId);
  return true;
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

  // Initialize OpenTelemetry tracing (no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset)
  await initTracing();

  // Create event bus early so startup events can be emitted
  const eventBus = createEventBus();

  const usePrettyEvents = (process.stdout.isTTY ?? false) && !opts.verbose && !opts.json;
  if (usePrettyEvents) {
    attachEventConsole(eventBus);
  } else if (opts.json || !process.stdout.isTTY) {
    attachJsonEventConsole(eventBus);
  }

  eventBus.emit({ type: 'server.config', requestId: 'system', timestamp: Date.now(),
    data: { profile: config.profile } });

  // Load providers
  logger.debug('loading_providers');
  const providers = await loadProviders(config);
  logger.debug('providers_loaded');

  // Seed process.env from the credential provider so synchronous readers
  // (e.g. the Anthropic proxy) can access tokens without the async API.
  const { loadCredentials } = await import('../dotenv.js');
  await loadCredentials(providers.credentials);

  eventBus.emit({ type: 'server.providers', requestId: 'system', timestamp: Date.now(), data: {} });

  // Inject additional channel providers (e.g. for testing)
  if (opts.channels?.length) {
    providers.channels.push(...opts.channels);
  }

  // Initialize DB + Conversation Store + Taint Budget + Router + IPC
  mkdirSync(dataDir(), { recursive: true });
  const db = await MessageQueue.create(dataFile('messages.db'));
  const conversationStore = await ConversationStore.create();
  const sessionStore = await SessionStore.create();
  const fileStore = await FileStore.create();
  const taintBudget = new TaintBudget({
    threshold: thresholdForProfile(config.profile),
  });
  const router = createRouter(providers, db, { taintBudget });

  const agentName = 'main';
  const agentDirVal = agentDirPath(agentName);
  const agentConfigDir = agentIdentityDir(agentName);
  const identityFilesDir = agentIdentityFilesDir(agentName);
  mkdirSync(agentDirVal, { recursive: true });
  mkdirSync(agentConfigDir, { recursive: true });
  mkdirSync(identityFilesDir, { recursive: true });

  // Migration: move identity files from legacy flat layout to new subdirectories.
  // Before restructure, all files lived directly in agentDirVal (~/.ax/agents/main/).
  // Now: identity files → agent/identity/, config files → agent/, admin files stay at top.
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
  // Remove stale copy if present (from earlier migration that placed it there).
  try { unlinkSync(join(identityFilesDir, 'USER_BOOTSTRAP.md')); } catch { /* may not exist */ }

  // Let scheduler know where the identity files dir is (for HEARTBEAT.md loading)
  config.scheduler.agent_dir = identityFilesDir;

  // First-run: copy default templates into the correct directories.
  // Identity files (AGENTS.md, HEARTBEAT.md) → identityFilesDir (mounted as /workspace/identity)
  // Config files (capabilities.yaml) → agentConfigDir (not in sandbox)
  // Bootstrap files (BOOTSTRAP.md, USER_BOOTSTRAP.md) → both agentConfigDir (authoritative)
  //   AND identityFilesDir (agent-readable copy in sandbox mount)
  const templatesDir = resolveTemplatesDir();
  const bootstrapAlreadyComplete =
    existsSync(join(identityFilesDir, 'SOUL.md')) && existsSync(join(identityFilesDir, 'IDENTITY.md'));

  // Identity files → identityFilesDir
  for (const file of ['AGENTS.md', 'HEARTBEAT.md']) {
    const dest = join(identityFilesDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest);
    }
  }

  // Config files → agentConfigDir
  for (const file of ['capabilities.yaml']) {
    const dest = join(agentConfigDir, file);
    const src = join(templatesDir, file);
    if (!existsSync(dest) && existsSync(src)) {
      copyFileSync(src, dest);
    }
  }

  // BOOTSTRAP.md → both agentConfigDir (authoritative) and identityFilesDir (agent-readable copy)
  // Don't re-create BOOTSTRAP.md if bootstrap already completed
  if (!bootstrapAlreadyComplete) {
    const src = join(templatesDir, 'BOOTSTRAP.md');
    if (existsSync(src)) {
      const configDest = join(agentConfigDir, 'BOOTSTRAP.md');
      const identityDest = join(identityFilesDir, 'BOOTSTRAP.md');
      if (!existsSync(configDest)) copyFileSync(src, configDest);
      if (!existsSync(identityDest)) copyFileSync(src, identityDest);
    }
  }

  // USER_BOOTSTRAP.md → agentConfigDir only (passed to agent via stdin payload, not mounted)
  {
    const src = join(templatesDir, 'USER_BOOTSTRAP.md');
    if (existsSync(src)) {
      const configDest = join(agentConfigDir, 'USER_BOOTSTRAP.md');
      if (!existsSync(configDest)) copyFileSync(src, configDest);
    }
  }

  // First-run: seed skills from <project-root>/skills/ into persistent ~/.ax location
  const persistentSkillsDir = agentSkillsDir(agentName);
  mkdirSync(persistentSkillsDir, { recursive: true });
  try {
    const existingSkills = readdirSync(persistentSkillsDir).filter(f => f.endsWith('.md'));
    if (existingSkills.length === 0) {
      const seedDir = resolveSeedSkillsDir();
      if (existsSync(seedDir)) {
        const seedFiles = readdirSync(seedDir).filter(f => f.endsWith('.md'));
        for (const f of seedFiles) {
          copyFileSync(join(seedDir, f), join(persistentSkillsDir, f));
        }
      }
    }
  } catch {
    // Non-fatal: skills seeding failure shouldn't block server startup
  }

  // Default user ID for IPC context (not used for admin seeding)
  const defaultUserId = process.env.USER ?? 'default';

  // Create empty admins file on first run; the first user to connect via a
  // channel (CLI, Slack, etc.) will be auto-promoted via claimBootstrapAdmin.
  const adminsPath = join(agentDirVal, 'admins');
  if (!existsSync(adminsPath)) {
    writeFileSync(adminsPath, '', 'utf-8');
  }

  // IPC socket server (internal agent-to-host socket)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');

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
    agentDir: identityFilesDir,
    logger,
    verbose: opts.verbose,
    fileStore,
    eventBus,
  };

  // Delegation callback: spawn a child agent via processCompletion with
  // optional runner/model overrides. The child agent gets its own sandbox,
  // IPC socket, and taint budget — full isolation.
  async function handleDelegate(req: DelegateRequest, ctx: IPCContext): Promise<string> {
    // Build a temporary config override for the child agent
    const childConfig: Config = {
      ...config,
      ...(req.runner ? { agent: req.runner } : {}),
      ...(req.model ? { models: { default: [req.model] } } : {}),
      ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
      ...(req.timeoutSec ? { sandbox: { ...config.sandbox, timeout_sec: req.timeoutSec } } : {}),
    };

    const childDeps: CompletionDeps = {
      ...completionDeps,
      config: childConfig,
    };

    const taskPrompt = req.context
      ? `${req.context}\n\n---\n\nTask: ${req.task}`
      : req.task;

    const requestId = req.requestId ?? `delegate-${randomUUID().slice(0, 8)}`;
    const result = await processCompletion(
      childDeps,
      taskPrompt,
      requestId,
      [],           // no client message history for delegated tasks
      undefined,    // no persistent session
      undefined,    // no pre-processed message (will go through router)
      ctx.userId,
    );

    return result.responseContent;
  }

  // Create orchestrator for agent lifecycle management and async delegation
  const orchestrator = createOrchestrator(eventBus, providers.audit);
  // Enable auto-state inference: maps llm.start/tool.call/llm.done events
  // to supervisor state transitions, which emit agent.state events that
  // the heartbeat monitor uses as proof of life.
  const disableAutoState = orchestrator.enableAutoState();

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
  });

  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer: NetServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);
  logger.debug('ipc_server_started', { socket: ipcSocketPath });

  let httpServer: HttpServer | null = null;
  let tcpServer: HttpServer | null = null;
  let listening = false;
  let draining = false;

  // In-flight request tracking for graceful shutdown
  let inflightCount = 0;
  let drainResolve: (() => void) | null = null;
  const DRAIN_TIMEOUT_MS = 30_000; // Max time to wait for in-flight requests to complete

  function trackRequestStart(): void { inflightCount++; }
  function trackRequestEnd(): void {
    inflightCount--;
    if (draining && inflightCount <= 0 && drainResolve) {
      drainResolve();
    }
  }

  /** Wait for all in-flight requests to complete, with a hard timeout. */
  function waitForDrain(): Promise<void> {
    if (inflightCount <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      drainResolve = resolve;
      // Hard timeout: don't wait forever for hung requests
      setTimeout(() => {
        if (inflightCount > 0) {
          logger.warn('drain_timeout', { inflight: inflightCount, timeoutMs: DRAIN_TIMEOUT_MS });
        }
        resolve();
      }, DRAIN_TIMEOUT_MS);
    });
  }

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

    // Reject new completion requests during shutdown (let health/models through)
    if (draining && url === '/v1/chat/completions') {
      sendError(res, 503, 'Server is shutting down — not accepting new requests');
      return;
    }

    if (url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: draining ? 'draining' : 'ok' }));
      return;
    }

    if (url === '/v1/models' && req.method === 'GET') {
      handleModels(res);
      return;
    }

    if (url === '/v1/chat/completions' && req.method === 'POST') {
      trackRequestStart();
      try {
        await handleCompletions(req, res);
      } catch (err) {
        logger.error('request_failed', { error: (err as Error).message });
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error');
        }
      } finally {
        trackRequestEnd();
      }
      return;
    }

    // File upload: POST /v1/files?agent=<name>&user=<id>
    if (url.startsWith('/v1/files') && req.method === 'POST') {
      try {
        await handleFileUpload(req, res, { fileStore });
      } catch (err) {
        logger.error('file_upload_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File upload failed');
      }
      return;
    }

    // File download: GET /v1/files/<fileId>?agent=<name>&user=<id>
    if (url.startsWith('/v1/files/') && req.method === 'GET') {
      try {
        await handleFileDownload(req, res, { fileStore });
      } catch (err) {
        logger.error('file_download_failed', { error: (err as Error).message });
        if (!res.headersSent) sendError(res, 500, 'File download failed');
      }
      return;
    }

    // SSE event stream: GET /v1/events?request_id=...&types=...
    if (url.startsWith('/v1/events') && req.method === 'GET') {
      handleEvents(req, res);
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

  /** SSE keepalive interval (ms). */
  const SSE_KEEPALIVE_MS = 15_000;

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    // Parse query params from URL
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

    // Send initial comment so the client knows the connection is alive
    res.write(':connected\n\n');

    const listener = (event: import('./event-bus.js').StreamEvent) => {
      // Apply type filter
      if (typeFilter && !typeFilter.has(event.type)) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client disconnected — unsubscribe handled below
      }
    };

    // Subscribe: use request-scoped if request_id provided, global otherwise
    const unsubscribe = requestIdFilter
      ? eventBus.subscribeRequest(requestIdFilter, listener)
      : eventBus.subscribe(listener);

    // Keepalive comment every 15s to prevent proxy/LB timeouts
    const keepalive = setInterval(() => {
      try {
        res.write(':keepalive\n\n');
      } catch {
        // Client gone
      }
    }, SSE_KEEPALIVE_MS);

    // Cleanup on client disconnect
    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
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

    // Derive a stable session ID for the workspace.
    // Priority: explicit session_id > user field (userId/conversationId) > random UUID.
    // The user field follows the OpenAI convention: "<userId>/<conversationId>".
    let sessionId = chatReq.session_id;
    if (!sessionId && chatReq.user) {
      const parts = chatReq.user.split('/');
      if (parts.length >= 2 && parts[0] && parts[1]) {
        // Extract agent name from model field (e.g. "agent:main" → "main")
        const agentPrefix = chatReq.model?.startsWith('agent:')
          ? chatReq.model.slice(6)
          : 'main';
        const candidate = `${agentPrefix}:http:${parts[0]}:${parts[1]}`;
        if (isValidSessionId(candidate)) {
          sessionId = candidate;
        }
      }
    }
    if (!sessionId) {
      sessionId = randomUUID();
    }

    // Extract last user message content (may be string or ContentBlock[])
    const lastMsg = chatReq.messages[chatReq.messages.length - 1];
    const content = lastMsg?.content ?? '';

    // Extract userId from user field (first segment before /)
    const userId = chatReq.user?.split('/')[0] || undefined;

    // Bootstrap gate: auto-promote the first HTTP user to admin (same as channel handler).
    if (userId && isAgentBootstrapMode(agentName) && !isAdmin(agentDirVal, userId)) {
      if (claimBootstrapAdmin(agentDirVal, userId)) {
        logger.info('bootstrap_admin_claimed', { provider: 'http', sender: userId });
      } else {
        sendError(res, 403, 'This agent is still being set up. Only admins can interact during bootstrap.');
        return;
      }
    }

    if (chatReq.stream) {
      // ── Streaming mode: subscribe to event bus and forward llm.chunk events as OpenAI SSE ──
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

      // Track whether we streamed any content via event bus
      let streamedContent = false;

      // Track tool call index for OpenAI-compatible incremental indexing
      let toolCallIndex = 0;
      let hasToolCalls = false;

      // Subscribe to event bus for this request's llm events.
      // Events are emitted synchronously during processCompletion, so the
      // listener fires inline and we can res.write() in real-time.
      const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
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
      });

      // Run completion — blocks while agent processes, but event callbacks fire during execution
      const { responseContent, finishReason } = await processCompletion(
        completionDeps, content, requestId, chatReq.messages, sessionId,
        undefined, userId,
      );

      unsubscribe();

      // Fallback: if no llm.chunk events were emitted (e.g. claude-code runner
      // bypasses the IPC LLM handler), send the full response as a single chunk.
      if (!streamedContent && responseContent) {
        sendSSEChunk(res, {
          id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
          choices: [{ index: 0, delta: { content: responseContent }, finish_reason: null }],
        });
      }

      // Finish chunk — use 'tool_calls' finish reason when the response included tool calls
      const streamFinishReason = hasToolCalls && finishReason === 'stop' ? 'tool_calls' as const : finishReason;
      sendSSEChunk(res, {
        id: requestId, object: 'chat.completion.chunk', created, model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: streamFinishReason }],
      });

      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // ── Non-streaming mode ──
      const { responseContent, finishReason } = await processCompletion(
        completionDeps, content, requestId, chatReq.messages, sessionId,
        undefined, userId,
      );

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
        logger.debug('server_listening', { socket: socketPath });
        resolveP();
      });
      httpServer!.on('error', rejectP);
    });

    // Optionally listen on a TCP port (for external clients like LM Studio)
    if (opts.port != null) {
      tcpServer = createHttpServer(handleRequest);
      await new Promise<void>((resolveP, rejectP) => {
        tcpServer!.listen(opts.port, '127.0.0.1', () => {
          logger.debug('server_listening_tcp', { port: opts.port });
          resolveP();
        });
        tcpServer!.on('error', rejectP);
      });
    }

    eventBus.emit({ type: 'server.ready', requestId: 'system', timestamp: Date.now(),
      data: { socket: socketPath, ...(opts.port != null ? { port: opts.port } : {}) } });

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
    try { fileStore.close(); } catch {
      logger.debug('file_store_close_failed');
    }

    // Flush and shut down OTel tracing
    await shutdownTracing();

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
