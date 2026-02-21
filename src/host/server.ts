/**
 * AX Server -- Long-running HTTP server for client connections.
 *
 * Merges main.ts initialization with completions.ts HTTP endpoints.
 * Exposes OpenAI-compatible API over Unix socket.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { axHome, dataDir, dataFile, isValidSessionId, workspaceDir, agentDir as agentDirPath } from '../paths.js';
import type { Config, ProviderRegistry } from '../types.js';
import { canonicalize, type InboundMessage } from '../providers/channel/types.js';
import { ConversationStore, type StoredTurn } from '../conversation-store.js';
import { loadProviders } from './registry.js';
import { MessageQueue } from '../db.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { type Logger, getLogger, truncate } from '../logger.js';
import { startAnthropicProxy } from './proxy.js';
import { diagnoseError } from '../errors.js';
import { ensureOAuthTokenFresh, refreshOAuthTokenFromEnv } from '../dotenv.js';
import { SessionStore } from '../session-store.js';
import { resolveDelivery } from './delivery.js';

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

interface OpenAIChatRequest {
  model?: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  max_tokens?: number;
  session_id?: string;
}

interface OpenAIChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: {
    index: number;
    message: { role: 'assistant'; content: string };
    finish_reason: 'stop' | 'length' | 'content_filter';
  }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: {
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: 'stop' | 'length' | 'content_filter' | null;
  }[];
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
  const templatesDir = resolve('templates');
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
  });

  // IPC socket server (internal agent-to-host socket)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const defaultCtx = { sessionId: 'server', agentId: 'system', userId: defaultUserId };
  const ipcServer: NetServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);
  logger.info('ipc_server_started', { socket: ipcSocketPath });

  // Session tracking for canary tokens
  const sessionCanaries = new Map<string, string>();

  // Deduplication for channel messages (Slack can deliver the same event multiple times).
  // TTL-based: remembers processed messages for a window so sequential retries are also blocked.
  const DEDUPE_WINDOW_MS = opts.dedupeWindowMs ?? 60_000;
  const DEDUPE_MAX = 1000;
  const processedMessages = new Map<string, number>();

  function isChannelDuplicate(key: string): boolean {
    const now = Date.now();
    const seen = processedMessages.get(key);
    if (seen !== undefined && now - seen < DEDUPE_WINDOW_MS) {
      return true;
    }
    processedMessages.set(key, now);
    // Lazy prune when over capacity
    if (processedMessages.size > DEDUPE_MAX) {
      for (const [k, ts] of processedMessages) {
        if (now - ts >= DEDUPE_WINDOW_MS) processedMessages.delete(k);
      }
    }
    return false;
  }

  // Model ID for API responses
  const modelId = providers.llm.name;

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

    // Process completion (server is stateless — clients manage history)
    const { responseContent, finishReason } = await processCompletion(content, requestId, chatReq.messages, chatReq.session_id);

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

  async function processCompletion(
    content: string,
    requestId: string,
    clientMessages: { role: string; content: string }[] = [],
    persistentSessionId?: string,
    preProcessed?: { sessionId: string; messageId: string; canaryToken: string },
    userId?: string,
    replyOptional?: boolean,
  ): Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter' }> {
    const sessionId = preProcessed?.sessionId ?? randomUUID();
    const reqLogger = logger.child({ reqId: requestId.slice(-8) });

    reqLogger.debug('completion_start', {
      sessionId,
      contentLength: content.length,
      contentPreview: truncate(content, 200),
      historyTurns: clientMessages.length,
    });

    let result: import('./router.js').RouterResult;

    if (preProcessed) {
      // Channel/scheduler path: message already scanned and enqueued by caller
      result = {
        queued: true,
        messageId: preProcessed.messageId,
        sessionId: preProcessed.sessionId,
        canaryToken: preProcessed.canaryToken,
        scanResult: { verdict: 'PASS' },
      };
      reqLogger.info('scan_inbound', { status: 'clean' });
      reqLogger.debug('inbound_clean', { messageId: result.messageId });
    } else {
      // HTTP API path: scan and enqueue here
      const inbound: InboundMessage = {
        id: sessionId,
        session: { provider: 'http', scope: 'dm', identifiers: { peer: 'client' } },
        sender: 'client',
        content,
        attachments: [],
        timestamp: new Date(),
      };

      result = await router.processInbound(inbound);

      if (!result.queued) {
        reqLogger.debug('inbound_blocked', { reason: result.scanResult.reason });
        reqLogger.info('scan_inbound', { status: 'blocked', reason: result.scanResult.reason ?? 'scan failed' });
        return {
          responseContent: `Request blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
          finishReason: 'content_filter',
        };
      }

      reqLogger.info('scan_inbound', { status: 'clean' });
      sessionCanaries.set(result.sessionId, result.canaryToken);
      reqLogger.debug('inbound_clean', { messageId: result.messageId });
    }

    // Dequeue the specific message we just enqueued (by ID, not FIFO)
    const queued = result.messageId ? db.dequeueById(result.messageId) : db.dequeue();
    if (!queued) {
      reqLogger.debug('dequeue_failed', { messageId: result.messageId });
      return { responseContent: 'Internal error: message not queued', finishReason: 'stop' };
    }

    let workspace = '';
    const isPersistent = !!persistentSessionId;
    let proxyCleanup: (() => void) | undefined;
    try {
      if (persistentSessionId) {
        workspace = workspaceDir(persistentSessionId);
        mkdirSync(workspace, { recursive: true });
      } else {
        workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
      }
      // Refresh skills into workspace before each agent spawn.
      // Copies from host skills dir and removes stale files (reverted/deleted skills).
      // Runs every turn so skill_propose auto-approvals appear on the next turn.
      const hostSkillsDir = resolve('skills');
      const wsSkillsDir = join(workspace, 'skills');
      mkdirSync(wsSkillsDir, { recursive: true });
      try {
        const hostFiles = readdirSync(hostSkillsDir).filter(f => f.endsWith('.md'));
        for (const f of hostFiles) {
          copyFileSync(join(hostSkillsDir, f), join(wsSkillsDir, f));
        }
        // Remove workspace skill files that no longer exist on host (deleted/reverted)
        const hostSet = new Set(hostFiles);
        for (const f of readdirSync(wsSkillsDir).filter(f => f.endsWith('.md'))) {
          if (!hostSet.has(f)) unlinkSync(join(wsSkillsDir, f));
        }
      } catch {
        reqLogger.debug('skills_refresh_failed', { hostSkillsDir });
      }

      // Build conversation history: prefer DB-persisted history for persistent sessions,
      // fall back to client-provided history for ephemeral sessions.
      let history: { role: 'user' | 'assistant'; content: string; sender?: string }[] = [];
      const maxTurns = config.history.max_turns;

      if (persistentSessionId && maxTurns > 0) {
        // maxTurns=0 disables history entirely (no loading, no saving).
        // Load persisted history from DB
        const storedTurns = conversationStore.load(persistentSessionId, maxTurns);

        // For thread sessions, prepend context from the parent channel session
        if (persistentSessionId.includes(':thread:') && config.history.thread_context_turns > 0) {
          // Derive parent session ID: replace :thread:...:threadTs with :channel:...
          const parts = persistentSessionId.split(':');
          const scopeIdx = parts.indexOf('thread');
          if (scopeIdx >= 0) {
            const parentParts = [...parts];
            parentParts[scopeIdx] = 'channel';
            // Remove the thread timestamp (last identifier after channel)
            parentParts.splice(scopeIdx + 2); // keep provider:channel:channelId
            const parentSessionId = parentParts.join(':');

            const parentTurns = conversationStore.load(parentSessionId, config.history.thread_context_turns);

            // Dedup: if last parent turn matches first thread turn (same content+sender), skip it
            if (parentTurns.length > 0 && storedTurns.length > 0) {
              const lastParent = parentTurns[parentTurns.length - 1];
              const firstThread = storedTurns[0];
              if (lastParent.content === firstThread.content && lastParent.sender === firstThread.sender) {
                parentTurns.pop();
              }
            }

            // Prepend parent context before thread history
            const parentHistory = parentTurns.map(t => ({
              role: t.role as 'user' | 'assistant',
              content: t.content,
              ...(t.sender ? { sender: t.sender } : {}),
            }));
            history.push(...parentHistory);
          }
        }

        // Add the session's own history
        history.push(...storedTurns.map(t => ({
          role: t.role as 'user' | 'assistant',
          content: t.content,
          ...(t.sender ? { sender: t.sender } : {}),
        })));
      } else {
        // Ephemeral: use client-provided history (minus the current message)
        history = clientMessages.slice(0, -1).map(m => ({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        }));
      }

      // Spawn sandbox
      const tsxBin = resolve('node_modules/.bin/tsx');
      const agentType = config.agent ?? 'pi-agent-core';

      // Start credential-injecting proxy for claude-code agents only.
      // claude-code talks to Anthropic directly via the proxy; all other agents
      // route LLM calls through IPC to the host-side LLM router.
      let proxySocketPath: string | undefined;
      const needsAnthropicProxy = agentType === 'claude-code';
      if (needsAnthropicProxy) {
        // Refresh OAuth token if expired or expiring (pre-flight check).
        // Handles 99% of cases where token expires between conversation turns.
        await ensureOAuthTokenFresh();

        // Fail fast if no credentials are available — don't spawn an agent
        // that will just retry 401s with exponential backoff for minutes.
        const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
        const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
        if (!hasApiKey && !hasOAuthToken) {
          db.fail(queued.id);
          return {
            responseContent: 'No API credentials configured. Run `ax configure` to set up authentication.',
            finishReason: 'stop',
          };
        }

        proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
        const proxy = startAnthropicProxy(proxySocketPath, undefined, async () => {
          await refreshOAuthTokenFromEnv();
        });
        proxyCleanup = proxy.stop;
      }

      const maxTokens = config.max_tokens ?? 8192;

      const spawnCommand = [tsxBin, resolve('src/agent/runner.ts'),
        '--agent', agentType,
        '--ipc-socket', ipcSocketPath,
        '--workspace', workspace,
        '--skills', wsSkillsDir,
        '--max-tokens', String(maxTokens),
        '--agent-dir', agentDirVal,
        ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
        ...(opts.verbose ? ['--verbose'] : []),
      ];

      reqLogger.debug('agent_spawn', {
        agentType,
        workspace,
        command: spawnCommand.join(' '),
        timeoutSec: config.sandbox.timeout_sec,
        memoryMB: config.sandbox.memory_mb,
      });

      const proc = await providers.sandbox.spawn({
        workspace,
        skills: wsSkillsDir,
        ipcSocket: ipcSocketPath,
        agentDir: agentDirVal,
        timeoutSec: config.sandbox.timeout_sec,
        memoryMB: config.sandbox.memory_mb,
        command: spawnCommand,
      });

      reqLogger.info('agent_spawn', { sandbox: 'subprocess' });

      // Send raw user message to agent (not the taint-tagged queued.content)
      // Include taint state so agent-side prompt modules can adapt behavior
      const taintState = taintBudget.getState(sessionId);
      const stdinPayload = JSON.stringify({
        history,
        message: content,
        taintRatio: taintState ? taintState.taintedTokens / (taintState.totalTokens || 1) : 0,
        taintThreshold: thresholdForProfile(config.profile),
        profile: config.profile,
        sandboxType: config.providers.sandbox,
        userId: userId ?? process.env.USER ?? 'default',
        replyOptional: replyOptional ?? false,
      });
      reqLogger.debug('stdin_write', { payloadBytes: stdinPayload.length });
      proc.stdin.write(stdinPayload);
      proc.stdin.end();

      // Collect stdout and stderr in parallel to avoid pipe buffer deadlocks.
      // Sequential collection can lose data when a stream fills its buffer
      // while the other stream is being drained.
      let response = '';
      let stderr = '';

      const stdoutDone = (async () => {
        for await (const chunk of proc.stdout) {
          response += chunk.toString();
        }
      })();

      const stderrDone = (async () => {
        for await (const chunk of proc.stderr) {
          const text = chunk.toString();
          stderr += text;
          if (opts.verbose) {
            for (const line of text.split('\n').filter((l: string) => l.trim())) {
              reqLogger.info('agent_stderr', { line });
            }
          }
        }
      })();

      await Promise.all([stdoutDone, stderrDone]);
      const exitCode = await proc.exitCode;

      reqLogger.debug('agent_exit', {
        exitCode,
        stdoutLength: response.length,
        stderrLength: stderr.length,
        stdoutPreview: truncate(response, 500),
        stderrPreview: stderr ? truncate(stderr, 1000) : undefined,
      });

      reqLogger.info('agent_complete', { durationSec: 0, exitCode });

      if (exitCode !== 0) {
        reqLogger.error('agent_failed', { exitCode, stderr: stderr.slice(0, 2000) });
        db.fail(queued.id);
        const diagnosed = diagnoseError(stderr || 'agent exited with no output');
        return { responseContent: `Agent processing failed: ${diagnosed.diagnosis}`, finishReason: 'stop' };
      }

      if (stderr) {
        reqLogger.warn('agent_stderr', { stderr: stderr.slice(0, 500) });
      }

      // Process outbound
      const canaryToken = sessionCanaries.get(queued.session_id) ?? '';
      reqLogger.debug('outbound_start', { responseLength: response.length, hasCanary: canaryToken.length > 0 });
      const outbound = await router.processOutbound(response, queued.session_id, canaryToken);

      if (outbound.canaryLeaked) {
        reqLogger.warn('canary_leaked', { sessionId: queued.session_id });
      }

      // Memorize if provider supports it
      if (providers.memory.memorize) {
        try {
          const fullHistory = [
            ...clientMessages,
            { role: 'assistant', content: outbound.content },
          ];
          await providers.memory.memorize(fullHistory);
        } catch (err) {
          reqLogger.warn('memorize_failed', { error: (err as Error).message });
        }
      }

      db.complete(queued.id);
      sessionCanaries.delete(queued.session_id);

      // Persist conversation turns for persistent sessions
      if (persistentSessionId && maxTurns > 0) {
        try {
          conversationStore.append(persistentSessionId, 'user', content, userId);
          conversationStore.append(persistentSessionId, 'assistant', outbound.content);
          // Lazy prune: only when count exceeds limit
          if (conversationStore.count(persistentSessionId) > maxTurns) {
            conversationStore.prune(persistentSessionId, maxTurns);
          }
        } catch (err) {
          reqLogger.warn('history_save_failed', { error: (err as Error).message });
        }
      }

      const finishReason = outbound.scanResult.verdict === 'BLOCK' ? 'content_filter' as const : 'stop' as const;
      reqLogger.debug('completion_done', {
        finishReason,
        responseLength: outbound.content.length,
        scanVerdict: outbound.scanResult.verdict,
      });
      return { responseContent: outbound.content, finishReason };

    } catch (err) {
      reqLogger.error('completion_error', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      db.fail(queued.id);
      return { responseContent: 'Internal processing error', finishReason: 'stop' };
    } finally {
      if (proxyCleanup) {
        try { proxyCleanup(); } catch {
          reqLogger.debug('proxy_cleanup_failed');
        }
      }
      if (workspace && !isPersistent) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch {
          reqLogger.debug('workspace_cleanup_failed', { workspace });
        }
      }
    }
  }

  // --- Utilities ---

  function sendError(res: ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } });
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  function sendSSEChunk(res: ServerResponse, chunk: OpenAIStreamChunk): void {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB

    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error('Request body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  // --- Lifecycle ---

  async function startServer(): Promise<void> {
    // Clean up stale persistent workspaces (older than 7 days)
    // Handles both legacy flat UUID dirs and new nested colon-separated dirs
    const workspacesRoot = join(dataDir(), 'workspaces');
    if (existsSync(workspacesRoot)) {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - SEVEN_DAYS_MS;

      /** Recursively find leaf workspace dirs (those containing files) and clean stale ones. */
      function cleanStaleWorkspaces(dir: string): boolean {
        try {
          const entries = readdirSync(dir);
          if (entries.length === 0) {
            // Empty dir — prune it
            rmSync(dir, { recursive: true, force: true });
            return true; // was removed
          }

          let hasFiles = false;
          let hasSubdirs = false;
          for (const entry of entries) {
            const entryPath = join(dir, entry);
            try {
              if (statSync(entryPath).isDirectory()) {
                hasSubdirs = true;
              } else {
                hasFiles = true;
              }
            } catch {
              // stat failed, skip
            }
          }

          if (hasFiles) {
            // This is a leaf workspace — check staleness
            try {
              const stat = statSync(dir);
              if (stat.mtimeMs < cutoff) {
                const relative = dir.slice(workspacesRoot.length + 1);
                rmSync(dir, { recursive: true, force: true });
                logger.info('cleaned_stale_workspace', { sessionId: relative });
                return true;
              }
            } catch {
              // stat failed, skip
            }
            return false;
          }

          if (hasSubdirs) {
            // Intermediate dir — recurse into subdirs
            for (const entry of entries) {
              const entryPath = join(dir, entry);
              try {
                if (statSync(entryPath).isDirectory()) {
                  cleanStaleWorkspaces(entryPath);
                }
              } catch {
                // stat failed, skip
              }
            }
            // After cleaning children, prune this dir if now empty
            try {
              if (readdirSync(dir).length === 0) {
                rmSync(dir, { recursive: true, force: true });
                return true;
              }
            } catch {
              // readdir failed, skip
            }
          }

          return false;
        } catch {
          logger.debug('workspace_cleanup_failed', { dir });
          return false;
        }
      }

      try {
        for (const entry of readdirSync(workspacesRoot)) {
          const entryPath = join(workspacesRoot, entry);
          try {
            if (statSync(entryPath).isDirectory()) {
              cleanStaleWorkspaces(entryPath);
            }
          } catch {
            logger.debug('workspace_stat_failed', { entry });
          }
        }
      } catch {
        logger.debug('workspaces_dir_read_failed');
      }
    }

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
          msg.content, `sched-${randomUUID().slice(0, 8)}`, [], undefined,
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
      channel.onMessage(async (msg: InboundMessage) => {
        if (!channel.shouldRespond(msg)) {
          logger.debug('channel_message_filtered', { provider: channel.name, sender: msg.sender });
          return;
        }

        // Deduplicate: Slack (and other providers) may deliver the same event
        // multiple times due to socket reconnections or missed acks.
        // Also handles app.message + app_mention overlap for thread messages.
        const dedupeKey = `${channel.name}:${msg.id}`;
        if (isChannelDuplicate(dedupeKey)) {
          logger.debug('channel_message_deduplicated', { provider: channel.name, messageId: msg.id });
          return;
        }

        // Thread gating: only process thread messages if the bot has participated
        // (i.e., was mentioned in the thread at some point, creating a session).
        const sessionId = canonicalize(msg.session);
        if (msg.session.scope === 'thread' && !msg.isMention) {
          const turnCount = conversationStore.count(sessionId);
          if (turnCount === 0) {
            logger.debug('thread_message_gated', { provider: channel.name, sessionId, reason: 'bot_not_in_thread' });
            return;
          }
        }

        // Thread backfill: on first entry into a thread, fetch prior messages
        if (msg.session.scope === 'thread' && msg.isMention && channel.fetchThreadHistory) {
          const turnCount = conversationStore.count(sessionId);
          if (turnCount === 0) {
            const threadChannel = msg.session.identifiers.channel;
            const threadTs = msg.session.identifiers.thread;
            if (threadChannel && threadTs) {
              try {
                const threadMessages = await channel.fetchThreadHistory(threadChannel, threadTs, 20);
                // Prepend thread history as user turns (exclude the current message)
                for (const tm of threadMessages) {
                  if (tm.ts === msg.id) continue; // skip current message
                  conversationStore.append(sessionId, 'user', tm.content, tm.sender);
                }
                logger.debug('thread_backfill', { sessionId, messagesAdded: threadMessages.length });
              } catch (err) {
                logger.warn('thread_backfill_failed', { sessionId, error: (err as Error).message });
              }
            }
          }
        }

        // Bootstrap gate: only admins can interact while the agent is being set up.
        if (isAgentBootstrapMode(agentDirVal) && !isAdmin(agentDirVal, msg.sender)) {
          logger.info('bootstrap_gate_blocked', { provider: channel.name, sender: msg.sender });
          await channel.send(msg.session, {
            content: 'This agent is still being set up. Only admins can interact during bootstrap.',
          });
          return;
        }

        // Eyes emoji: acknowledge receipt
        if (channel.addReaction) {
          channel.addReaction(msg.session, msg.id, 'eyes').catch(() => {});
        }

        try {
          const result = await router.processInbound(msg);
          if (!result.queued) {
            await channel.send(msg.session, {
              content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
            });
            return;
          }
          sessionCanaries.set(result.sessionId, result.canaryToken);

          // Determine if reply is optional (LLM can choose not to respond)
          const replyOptional = !msg.isMention;

          const { responseContent } = await processCompletion(
            msg.content, `ch-${randomUUID().slice(0, 8)}`, [], sessionId,
            { sessionId: result.sessionId, messageId: result.messageId!, canaryToken: result.canaryToken },
            msg.sender,
            replyOptional,
          );

          // If LLM chose not to reply, skip sending
          if (responseContent.trim()) {
            await channel.send(msg.session, { content: responseContent });
          }

          // Track last channel session for "last" delivery target resolution
          sessionStore.trackSession(agentName, msg.session);
        } finally {
          // Remove eyes emoji regardless of outcome
          if (channel.removeReaction) {
            channel.removeReaction(msg.session, msg.id, 'eyes').catch(() => {});
          }
        }
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
