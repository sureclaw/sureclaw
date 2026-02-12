/**
 * AX Server -- Long-running HTTP server for client connections.
 *
 * Merges main.ts initialization with completions.ts HTTP endpoints.
 * Exposes OpenAI-compatible API over Unix socket.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Server as NetServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { axHome, dataDir, dataFile, isValidSessionId, workspaceDir } from '../paths.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { InboundMessage } from '../providers/channel/types.js';
import { loadProviders } from './registry.js';
import { MessageQueue } from '../db.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer } from './ipc-server.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import { createLogger, type Logger } from '../logger.js';
import { startAnthropicProxy } from './proxy.js';
import { debug, truncate } from '../logger.js';

const SRC = 'host:server';

// =====================================================
// Types
// =====================================================

export interface ServerOptions {
  socketPath?: string;
  daemon?: boolean;
  verbose?: boolean;
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
// Server Factory
// =====================================================

export async function createServer(
  config: Config,
  opts: ServerOptions = {},
): Promise<AxServer> {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');

  // Initialize logger
  const logFormat = process.env.LOG_FORMAT === 'json' ? 'json' as const : 'pretty' as const;
  const logger = createLogger({ format: logFormat });

  // Load providers
  logger.info('Loading providers...');
  const providers = await loadProviders(config);
  logger.info('Providers loaded');

  // Initialize DB + Taint Budget + Router + IPC
  mkdirSync(dataDir(), { recursive: true });
  const db = new MessageQueue(dataFile('messages.db'));
  const taintBudget = new TaintBudget({
    threshold: thresholdForProfile(config.profile),
  });
  const router = createRouter(providers, db, { taintBudget });
  const agentName = 'assistant';
  const agentDir = resolve('agents', agentName);
  const handleIPC = createIPCHandler(providers, { taintBudget, agentDir, profile: config.profile });

  // IPC socket server (internal agent-to-host socket)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const defaultCtx = { sessionId: 'server', agentId: 'system' };
  const ipcServer: NetServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);
  logger.info('IPC server started', { socket: ipcSocketPath });

  // Session tracking for canary tokens
  const sessionCanaries = new Map<string, string>();

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
        logger.error('Request failed', { error: (err as Error).message });
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
      sendError(res, 400, 'Invalid session_id: must be a valid UUID');
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
  ): Promise<{ responseContent: string; finishReason: 'stop' | 'content_filter' }> {
    const sessionId = randomUUID();
    debug(SRC, 'completion_start', {
      requestId,
      sessionId,
      contentLength: content.length,
      contentPreview: truncate(content, 200),
      historyTurns: clientMessages.length,
    });

    const inbound: InboundMessage = {
      id: sessionId,
      channel: 'http',
      sender: 'client',
      content,
      timestamp: new Date(),
      isGroup: false,
    };

    const result = await router.processInbound(inbound);

    if (!result.queued) {
      debug(SRC, 'inbound_blocked', { requestId, reason: result.scanResult.reason });
      logger.scan_inbound('blocked', result.scanResult.reason ?? 'scan failed');
      return {
        responseContent: `Request blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
        finishReason: 'content_filter',
      };
    }

    logger.scan_inbound('clean');
    sessionCanaries.set(result.sessionId, result.canaryToken);
    debug(SRC, 'inbound_clean', { requestId, messageId: result.messageId });

    // Dequeue the specific message we just enqueued (by ID, not FIFO)
    const queued = result.messageId ? db.dequeueById(result.messageId) : db.dequeue();
    if (!queued) {
      debug(SRC, 'dequeue_failed', { requestId, messageId: result.messageId });
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
      // Copy skills into workspace so agent only sees sandbox-local paths
      const hostSkillsDir = resolve('skills');
      const wsSkillsDir = join(workspace, 'skills');
      mkdirSync(wsSkillsDir, { recursive: true });
      try {
        for (const f of readdirSync(hostSkillsDir)) {
          if (f.endsWith('.md')) copyFileSync(join(hostSkillsDir, f), join(wsSkillsDir, f));
        }
      } catch { /* skills dir may not exist */ }

      // Write workspace files with raw user message (no taint tags or canary)
      writeFileSync(join(workspace, 'CONTEXT.md'), `# Session: ${queued.session_id}\n`);
      writeFileSync(join(workspace, 'message.txt'), content);

      // Use client-provided conversation history (server is stateless)
      const history = clientMessages.slice(0, -1).map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Spawn sandbox
      const tsxBin = resolve('node_modules/.bin/tsx');
      const agentType = config.agent ?? 'pi-agent-core';

      // Start credential-injecting proxy for agents using a real LLM provider.
      // The proxy forwards Anthropic API requests with injected credentials.
      // Mock LLM uses IPC only — no proxy needed.
      let proxySocketPath: string | undefined;
      if (config.providers.llm !== 'mock') {
        proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
        const proxy = startAnthropicProxy(proxySocketPath);
        proxyCleanup = proxy.stop;
      }

      const maxTokens = config.max_tokens ?? 8192;
      const spawnCommand = [tsxBin, resolve('src/agent/runner.ts'),
        '--agent', agentType,
        '--ipc-socket', ipcSocketPath,
        '--workspace', workspace,
        '--skills', wsSkillsDir,
        '--max-tokens', String(maxTokens),
        '--agent-dir', agentDir,
        ...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
        ...(opts.verbose ? ['--verbose'] : []),
      ];

      debug(SRC, 'agent_spawn', {
        requestId,
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
        timeoutSec: config.sandbox.timeout_sec,
        memoryMB: config.sandbox.memory_mb,
        command: spawnCommand,
      });

      logger.agent_spawn(requestId, 'subprocess');

      // Send raw user message to agent (not the taint-tagged queued.content)
      const stdinPayload = JSON.stringify({ history, message: content });
      debug(SRC, 'stdin_write', { requestId, payloadBytes: stdinPayload.length });
      proc.stdin.write(stdinPayload);
      proc.stdin.end();

      // Collect stdout
      let response = '';
      for await (const chunk of proc.stdout) {
        response += chunk.toString();
      }

      // Collect stderr — in verbose mode, also stream to logger in real-time
      let stderr = '';
      for await (const chunk of proc.stderr) {
        const text = chunk.toString();
        stderr += text;
        if (opts.verbose) {
          // Stream verbose lines to logger as they arrive
          for (const line of text.split('\n').filter((l: string) => l.trim())) {
            logger.info(line);
          }
        }
      }

      const exitCode = await proc.exitCode;

      debug(SRC, 'agent_exit', {
        requestId,
        exitCode,
        stdoutLength: response.length,
        stderrLength: stderr.length,
        stdoutPreview: truncate(response, 500),
        stderrPreview: stderr ? truncate(stderr, 1000) : undefined,
      });

      if (stderr) {
        logger.warn('Agent stderr', { stderr: stderr.slice(0, 500) });
      }

      logger.agent_complete(requestId, 0, exitCode);

      if (exitCode !== 0) {
        debug(SRC, 'agent_failed', { requestId, exitCode, stderr: truncate(stderr, 1000) });
        db.fail(queued.id);
        return { responseContent: 'Agent processing failed', finishReason: 'stop' };
      }

      // Process outbound
      const canaryToken = sessionCanaries.get(queued.session_id) ?? '';
      debug(SRC, 'outbound_start', { requestId, responseLength: response.length, hasCanary: canaryToken.length > 0 });
      const outbound = await router.processOutbound(response, queued.session_id, canaryToken);

      if (outbound.canaryLeaked) {
        debug(SRC, 'canary_leaked', { requestId, sessionId: queued.session_id });
        logger.warn('Canary leak detected -- response redacted', { session_id: queued.session_id });
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
          logger.warn('memorize() failed (non-fatal)', { error: (err as Error).message });
        }
      }

      db.complete(queued.id);
      sessionCanaries.delete(queued.session_id);

      const finishReason = outbound.scanResult.verdict === 'BLOCK' ? 'content_filter' as const : 'stop' as const;
      debug(SRC, 'completion_done', {
        requestId,
        finishReason,
        responseLength: outbound.content.length,
        scanVerdict: outbound.scanResult.verdict,
      });
      return { responseContent: outbound.content, finishReason };

    } catch (err) {
      debug(SRC, 'completion_error', {
        requestId,
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      logger.error('Processing error', { error: (err as Error).message });
      db.fail(queued.id);
      return { responseContent: 'Internal processing error', finishReason: 'stop' };
    } finally {
      if (proxyCleanup) {
        try { proxyCleanup(); } catch { /* cleanup best-effort */ }
      }
      if (workspace && !isPersistent) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
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
    const workspacesRoot = join(dataDir(), 'workspaces');
    if (existsSync(workspacesRoot)) {
      const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - SEVEN_DAYS_MS;
      try {
        for (const entry of readdirSync(workspacesRoot)) {
          const entryPath = join(workspacesRoot, entry);
          try {
            const stat = statSync(entryPath);
            if (stat.isDirectory() && stat.mtimeMs < cutoff) {
              rmSync(entryPath, { recursive: true, force: true });
              logger.info('Cleaned stale workspace', { sessionId: entry });
            }
          } catch { /* skip entries we can't stat */ }
        }
      } catch { /* skip if workspaces dir can't be read */ }
    }

    // Remove stale socket
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    httpServer = createHttpServer(handleRequest);

    await new Promise<void>((resolveP, rejectP) => {
      httpServer!.listen(socketPath, () => {
        listening = true;
        logger.info('AX server listening', { socket: socketPath });
        resolveP();
      });
      httpServer!.on('error', rejectP);
    });

    // Start scheduler
    await providers.scheduler.start(async (msg: InboundMessage) => {
      const result = await router.processInbound(msg);
      if (result.queued) {
        sessionCanaries.set(result.sessionId, result.canaryToken);
        const { responseContent } = await processCompletion(msg.content, `sched-${randomUUID().slice(0, 8)}`);
        logger.info('Scheduler message processed', { content_length: responseContent.length });
      }
    });

    // Connect channel providers (Slack, Discord, etc.)
    for (const channel of providers.channels) {
      channel.onMessage(async (msg: InboundMessage) => {
        const result = await router.processInbound(msg);
        if (!result.queued) {
          await channel.send(msg.sender, {
            content: `Message blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
          });
          return;
        }
        sessionCanaries.set(result.sessionId, result.canaryToken);
        const { responseContent } = await processCompletion(msg.content, `ch-${randomUUID().slice(0, 8)}`, [], msg.id);
        await channel.send(msg.sender, { content: responseContent });
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
    try { ipcServer.close(); } catch { /* ignore */ }

    // Close DB
    try { db.close(); } catch { /* ignore */ }

    // Clean up sockets
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    try { rmSync(ipcSocketDir, { recursive: true, force: true }); } catch { /* ignore */ }

    listening = false;
  }

  return {
    get listening() { return listening; },
    start: startServer,
    stop: stopServer,
  };
}
