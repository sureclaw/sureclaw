/**
 * OpenAI-compatible completions gateway.
 *
 * Default: Unix socket (safe, no auth needed).
 * Optional: localhost TCP with mandatory bearer token.
 *
 * Supports POST /v1/chat/completions with streaming (SSE) and non-streaming.
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Router } from './router.js';
import type { ProviderRegistry, InboundMessage, Config } from './providers/types.js';
import type { MessageQueue, ConversationStore } from './db.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface CompletionsGatewayOptions {
  /** Unix socket path (default mode, mutually exclusive with port). */
  socketPath?: string;
  /** TCP port on localhost (opt-in mode, requires bearerToken). */
  port?: number;
  /** Bearer token for TCP mode — REQUIRED when port is set. */
  bearerToken?: string;
  /** Model ID to report in responses (default: the LLM provider name). */
  defaultModel?: string;
}

interface OpenAIChatRequest {
  model?: string;
  messages: { role: string; content: string }[];
  stream?: boolean;
  max_tokens?: number;
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

// ═══════════════════════════════════════════════════════
// Gateway
// ═══════════════════════════════════════════════════════

export interface CompletionsGateway {
  server: Server;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createCompletionsGateway(
  providers: ProviderRegistry,
  router: Router,
  db: MessageQueue,
  conversations: ConversationStore,
  config: Config,
  ipcSocketPath: string,
  opts: CompletionsGatewayOptions,
): CompletionsGateway {

  // Validate: TCP mode requires a bearer token
  if (opts.port !== undefined && !opts.bearerToken) {
    throw new Error('TCP mode requires a bearerToken for authentication');
  }

  const modelId = opts.defaultModel ?? providers.llm.name;

  // Session canary tracking (mirrors host.ts pattern)
  const sessionCanaries = new Map<string, string>();

  function authorize(req: IncomingMessage): boolean {
    // Unix socket mode — no auth needed (OS-level access control)
    if (!opts.port) return true;

    const authHeader = req.headers.authorization;
    if (!authHeader) return false;
    const [scheme, token] = authHeader.split(' ');
    return scheme === 'Bearer' && token === opts.bearerToken;
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 1024 * 1024; // 1MB

    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) {
        throw new Error('Request body too large');
      }
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf-8');
  }

  function sendError(res: ServerResponse, status: number, message: string): void {
    const body = JSON.stringify({
      error: { message, type: 'invalid_request_error', code: null },
    });
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  }

  function sendSSEChunk(res: ServerResponse, chunk: OpenAIStreamChunk): void {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  function sendSSEDone(res: ServerResponse): void {
    res.write('data: [DONE]\n\n');
    res.end();
  }

  async function processCompletion(
    chatReq: OpenAIChatRequest,
    sessionId: string,
  ): Promise<{ content: string; finishReason: 'stop' | 'content_filter' }> {
    // Build user message from last message in the request
    const lastMsg = chatReq.messages[chatReq.messages.length - 1];
    const userContent = lastMsg?.content ?? '';

    // Create an InboundMessage for the router
    const inbound: InboundMessage = {
      id: sessionId,
      channel: 'completions',
      sender: 'api',
      content: userContent,
      timestamp: new Date(),
      isGroup: false,
    };

    // Process through router (scan, taint-tag, enqueue)
    const result = await router.processInbound(inbound);

    if (!result.queued) {
      return {
        content: `Request blocked: ${result.scanResult.reason ?? 'security scan failed'}`,
        finishReason: 'content_filter',
      };
    }

    sessionCanaries.set(result.sessionId, result.canaryToken);

    // Dequeue and process
    const queued = db.dequeue();
    if (!queued) {
      return { content: 'Internal error: message not queued', finishReason: 'stop' };
    }

    let workspace = '';
    try {
      workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
      const skillsDir = resolve('skills');

      writeFileSync(join(workspace, 'CONTEXT.md'), `# Session: ${queued.session_id}\n`);
      writeFileSync(join(workspace, 'message.txt'), queued.content);

      // Load conversation history
      const history = conversations.getHistory(queued.session_id);

      // Spawn sandbox
      const tsxBin = resolve('node_modules/.bin/tsx');
      const proc = await providers.sandbox.spawn({
        workspace,
        skills: skillsDir,
        ipcSocket: ipcSocketPath,
        timeoutSec: config.sandbox.timeout_sec,
        memoryMB: config.sandbox.memory_mb,
        command: [tsxBin, resolve('src/container/agent-runner.ts'),
          '--ipc-socket', ipcSocketPath,
          '--workspace', workspace,
          '--skills', skillsDir,
        ],
      });

      // Send history + message to agent stdin
      const stdinPayload = JSON.stringify({ history, message: queued.content });
      proc.stdin.write(stdinPayload);
      proc.stdin.end();

      // Collect stdout
      let response = '';
      for await (const chunk of proc.stdout) {
        response += chunk.toString();
      }

      // Collect stderr
      let stderr = '';
      for await (const chunk of proc.stderr) {
        stderr += chunk.toString();
      }

      const exitCode = await proc.exitCode;

      if (stderr) {
        console.error(`[completions] Agent stderr: ${stderr.slice(0, 500)}`);
      }

      if (exitCode !== 0) {
        console.error(`[completions] Agent exited with code ${exitCode}`);
        db.fail(queued.id);
        return { content: 'Agent processing failed', finishReason: 'stop' };
      }

      // Process outbound through router
      const canaryToken = sessionCanaries.get(queued.session_id) ?? '';
      const outbound = await router.processOutbound(response, queued.session_id, canaryToken);

      if (outbound.canaryLeaked) {
        console.error('[completions] SECURITY: Canary token leaked — response redacted');
      }

      // Store conversation turns
      conversations.addTurn(queued.session_id, 'user', queued.content);
      conversations.addTurn(queued.session_id, 'assistant', outbound.content);

      db.complete(queued.id);
      sessionCanaries.delete(queued.session_id);

      const finishReason = outbound.scanResult.verdict === 'BLOCK' ? 'content_filter' as const : 'stop' as const;
      return { content: outbound.content, finishReason };

    } catch (err) {
      console.error(`[completions] Processing error: ${err}`);
      db.fail(queued.id);
      return { content: 'Internal processing error', finishReason: 'stop' };
    } finally {
      if (workspace) {
        try { rmSync(workspace, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
      }
    }
  }

  async function handleChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Parse request body
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

    // Validate required fields
    if (!chatReq.messages || !Array.isArray(chatReq.messages) || chatReq.messages.length === 0) {
      sendError(res, 400, 'messages array is required and must not be empty');
      return;
    }

    const requestId = `chatcmpl-${randomUUID()}`;
    const sessionId = randomUUID();
    const created = Math.floor(Date.now() / 1000);
    const requestModel = chatReq.model ?? modelId;

    if (chatReq.stream) {
      // Streaming mode — SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Request-Id': requestId,
      });

      // Send initial role chunk
      sendSSEChunk(res, {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: requestModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      // Process the completion
      const { content, finishReason } = await processCompletion(chatReq, sessionId);

      // Send content chunk
      sendSSEChunk(res, {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: requestModel,
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      });

      // Send finish chunk
      sendSSEChunk(res, {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model: requestModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });

      sendSSEDone(res);
    } else {
      // Non-streaming mode
      const { content, finishReason } = await processCompletion(chatReq, sessionId);

      const response: OpenAIChatResponse = {
        id: requestId,
        object: 'chat.completion',
        created,
        model: requestModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: finishReason,
        }],
        usage: {
          prompt_tokens: 0,   // Not tracked at this layer
          completion_tokens: 0,
          total_tokens: 0,
        },
      };

      const responseBody = JSON.stringify(response);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(responseBody),
        'X-Request-Id': requestId,
      });
      res.end(responseBody);
    }
  }

  const server = createServer(async (req, res) => {
    // Auth check
    if (!authorize(req)) {
      sendError(res, 401, 'Invalid or missing bearer token');
      return;
    }

    // Route matching
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        await handleChatCompletions(req, res);
      } catch (err) {
        console.error(`[completions] Unhandled error: ${err}`);
        if (!res.headersSent) {
          sendError(res, 500, 'Internal server error');
        }
      }
      return;
    }

    // Health check endpoint
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      const body = JSON.stringify({
        object: 'list',
        data: [{
          id: modelId,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'ax',
        }],
      });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    sendError(res, 404, `Unknown endpoint: ${req.method} ${url.pathname}`);
  });

  return {
    server,

    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.on('error', reject);

        if (opts.socketPath) {
          server.listen(opts.socketPath, () => {
            console.log(`[completions] Listening on Unix socket: ${opts.socketPath}`);
            resolve();
          });
        } else if (opts.port) {
          // TCP mode: bind to localhost ONLY
          server.listen(opts.port, '127.0.0.1', () => {
            console.log(`[completions] Listening on http://127.0.0.1:${opts.port}`);
            resolve();
          });
        } else {
          reject(new Error('Either socketPath or port must be specified'));
        }
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
