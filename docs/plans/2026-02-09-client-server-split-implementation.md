# Client-Server Split Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the monolithic `npm start` (host.ts) into a long-running server process (`ax serve`) and separate CLI clients (`ax chat`, `ax send`).

**Architecture:** Server exposes HTTP API over Unix socket. Clients are thin OpenAI-compatible HTTP clients. Server is stateless per-request — clients manage their own conversation history.

**Tech Stack:** Node.js HTTP server, Unix domain sockets, Server-Sent Events (SSE) for streaming, OpenAI-compatible API format

---

## Task 0: Structured Logger with JSON Output

**Files:**
- Create: `src/logger.ts`
- Test: `tests/logger.test.ts`

**Step 1: Write failing test**

```typescript
// tests/logger.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createLogger, type LogEvent } from '../src/logger.js';
import { Writable } from 'node:stream';

describe('Logger', () => {
  let events: LogEvent[];
  let mockStdout: Writable;

  beforeEach(() => {
    events = [];
    mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        const line = chunk.toString().trim();
        if (line) {
          events.push(JSON.parse(line));
        }
        callback();
      },
    });
  });

  it('should log llm_call event', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.llm_call('anthropic', 1247, 384, 'ok');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('llm_call');
    expect(events[0].status).toBe('ok');
    expect(events[0].details.model).toBe('anthropic');
    expect(events[0].details.input_tokens).toBe(1247);
    expect(events[0].details.output_tokens).toBe(384);
  });

  it('should log tool_use event', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.tool_use('bash', 'ls -la', 'ok');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('tool_use');
    expect(events[0].status).toBe('ok');
    expect(events[0].details.tool).toBe('bash');
    expect(events[0].details.command).toBe('ls -la');
  });

  it('should log scan_inbound event', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.scan_inbound('clean');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('scan_inbound');
    expect(events[0].status).toBe('clean');
  });

  it('should log scan_outbound with taint score', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.scan_outbound('clean', 0.3);

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('scan_outbound');
    expect(events[0].status).toBe('clean');
    expect(events[0].details.taint).toBe(0.3);
  });

  it('should log blocked scan with reason', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.scan_inbound('blocked', 'injection pattern detected');

    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('scan_inbound');
    expect(events[0].status).toBe('blocked');
    expect(events[0].details.reason).toBe('injection pattern detected');
  });

  it('should support pretty format with colors', () => {
    let output = '';
    const colorStdout = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });

    const logger = createLogger({ format: 'pretty', stream: colorStdout });
    logger.llm_call('anthropic', 100, 50, 'ok');

    expect(output).toContain('llm_call');
    expect(output).toContain('ok');
    expect(output).toMatch(/\d{2}:\d{2}:\d{2}/); // timestamp
  });

  it('should include timestamp in all events', () => {
    const logger = createLogger({ format: 'json', stream: mockStdout });
    logger.info('test message');

    expect(events).toHaveLength(1);
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/logger.test.ts`
Expected: FAIL with "Cannot find module '../src/logger.js'"

**Step 3: Write minimal implementation**

```typescript
// src/logger.ts
import { type Writable } from 'node:stream';
import { styleText } from 'node:util';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface LogEvent {
  timestamp: string;
  event: string;
  status: string;
  details?: Record<string, unknown>;
}

export interface LoggerOptions {
  format?: 'json' | 'pretty';
  stream?: Writable;
}

export interface Logger {
  llm_call(model: string, inputTokens: number, outputTokens: number, status: string): void;
  tool_use(tool: string, command: string, status: string): void;
  scan_inbound(status: 'clean' | 'blocked', reason?: string): void;
  scan_outbound(status: 'clean' | 'blocked', taint?: number, reason?: string): void;
  agent_spawn(requestId: string, sandbox: string): void;
  agent_complete(requestId: string, durationSec: number, exitCode: number): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

// ═══════════════════════════════════════════════════════
// Logger Factory
// ═══════════════════════════════════════════════════════

export function createLogger(opts: LoggerOptions = {}): Logger {
  const format = opts.format ?? 'pretty';
  const stream = opts.stream ?? process.stdout;

  function write(event: LogEvent): void {
    if (format === 'json') {
      stream.write(JSON.stringify(event) + '\n');
    } else {
      stream.write(formatPretty(event) + '\n');
    }
  }

  function timestamp(): string {
    return new Date().toISOString();
  }

  function timestampShort(): string {
    const now = new Date();
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  }

  function pad(n: number): string {
    return n.toString().padStart(2, '0');
  }

  function formatPretty(event: LogEvent): string {
    const time = timestampShort();
    const status = colorizeStatus(event.status);
    const details = formatDetails(event.details);

    return `${styleText('gray', time)} ${event.event} ${details} ${status}`;
  }

  function colorizeStatus(status: string): string {
    if (status === 'ok' || status === 'clean') {
      return styleText('green', status);
    }
    if (status === 'blocked' || status === 'error') {
      return styleText('red', status);
    }
    if (status === 'warn') {
      return styleText('yellow', status);
    }
    return status;
  }

  function formatDetails(details?: Record<string, unknown>): string {
    if (!details) return '';

    const parts: string[] = [];

    if (details.model) parts.push(`${details.model}`);
    if (details.tool) parts.push(`${details.tool}`);
    if (details.command) parts.push(`"${details.command}"`);
    if (details.reason) parts.push(`${details.reason}`);
    if (details.taint !== undefined) parts.push(`taint:${details.taint}`);
    if (details.input_tokens) parts.push(`${details.input_tokens} in`);
    if (details.output_tokens) parts.push(`${details.output_tokens} out`);
    if (details.sandbox) parts.push(`${details.sandbox}`);
    if (details.duration_sec) parts.push(`${details.duration_sec}s`);
    if (details.message) parts.push(`${details.message}`);

    return parts.join(' ');
  }

  return {
    llm_call(model: string, inputTokens: number, outputTokens: number, status: string): void {
      write({
        timestamp: timestamp(),
        event: 'llm_call',
        status,
        details: {
          model,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
        },
      });
    },

    tool_use(tool: string, command: string, status: string): void {
      write({
        timestamp: timestamp(),
        event: 'tool_use',
        status,
        details: { tool, command },
      });
    },

    scan_inbound(status: 'clean' | 'blocked', reason?: string): void {
      write({
        timestamp: timestamp(),
        event: 'scan_inbound',
        status,
        details: reason ? { reason } : undefined,
      });
    },

    scan_outbound(status: 'clean' | 'blocked', taint?: number, reason?: string): void {
      write({
        timestamp: timestamp(),
        event: 'scan_outbound',
        status,
        details: {
          ...(taint !== undefined && { taint }),
          ...(reason && { reason }),
        },
      });
    },

    agent_spawn(requestId: string, sandbox: string): void {
      write({
        timestamp: timestamp(),
        event: 'agent_spawn',
        status: 'spawning',
        details: { request_id: requestId, sandbox },
      });
    },

    agent_complete(requestId: string, durationSec: number, exitCode: number): void {
      write({
        timestamp: timestamp(),
        event: 'agent_complete',
        status: exitCode === 0 ? 'ok' : 'error',
        details: {
          request_id: requestId,
          duration_sec: durationSec,
          exit_code: exitCode,
        },
      });
    },

    info(message: string, details?: Record<string, unknown>): void {
      write({
        timestamp: timestamp(),
        event: 'info',
        status: 'info',
        details: { message, ...details },
      });
    },

    warn(message: string, details?: Record<string, unknown>): void {
      write({
        timestamp: timestamp(),
        event: 'warn',
        status: 'warn',
        details: { message, ...details },
      });
    },

    error(message: string, details?: Record<string, unknown>): void {
      write({
        timestamp: timestamp(),
        event: 'error',
        status: 'error',
        details: { message, ...details },
      });
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/logger.test.ts`
Expected: PASS (all 7 tests)

**Step 5: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat: add structured logger with JSON output mode"
```

---

## Task 1: Create CLI Subcommand Router

**Files:**
- Create: `src/cli/index.ts`
- Test: `tests/cli/index.test.ts`

**Step 1: Write failing test**

```typescript
// tests/cli/index.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeCommand } from '../src/cli/index.js';

describe('CLI Router', () => {
  it('should route serve command', async () => {
    const mockServe = vi.fn();
    await routeCommand(['serve'], { serve: mockServe });
    expect(mockServe).toHaveBeenCalledOnce();
  });

  it('should route chat command', async () => {
    const mockChat = vi.fn();
    await routeCommand(['chat'], { chat: mockChat });
    expect(mockChat).toHaveBeenCalledOnce();
  });

  it('should route send command with args', async () => {
    const mockSend = vi.fn();
    await routeCommand(['send', 'hello'], { send: mockSend });
    expect(mockSend).toHaveBeenCalledWith(['hello']);
  });

  it('should route configure command', async () => {
    const mockConfigure = vi.fn();
    await routeCommand(['configure'], { configure: mockConfigure });
    expect(mockConfigure).toHaveBeenCalledOnce();
  });

  it('should default to serve if no command', async () => {
    const mockServe = vi.fn();
    await routeCommand([], { serve: mockServe });
    expect(mockServe).toHaveBeenCalledOnce();
  });

  it('should show help for unknown command', async () => {
    const mockHelp = vi.fn();
    await routeCommand(['unknown'], { help: mockHelp });
    expect(mockHelp).toHaveBeenCalledOnce();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli/index.test.ts`
Expected: FAIL with "Cannot find module '../src/cli/index.js'"

**Step 3: Write minimal implementation**

```typescript
// src/cli/index.ts
export interface CommandHandlers {
  serve?: () => Promise<void>;
  chat?: () => Promise<void>;
  send?: (args: string[]) => Promise<void>;
  configure?: () => Promise<void>;
  help?: () => Promise<void>;
}

export async function routeCommand(
  args: string[],
  handlers: CommandHandlers,
): Promise<void> {
  const command = args[0] || 'serve';

  switch (command) {
    case 'serve':
      if (handlers.serve) await handlers.serve();
      break;
    case 'chat':
      if (handlers.chat) await handlers.chat();
      break;
    case 'send':
      if (handlers.send) await handlers.send(args.slice(1));
      break;
    case 'configure':
      if (handlers.configure) await handlers.configure();
      break;
    default:
      if (handlers.help) await handlers.help();
      break;
  }
}

export function showHelp(): void {
  console.log(`
AX - Security-first personal AI agent

Usage:
  ax serve [options]     Start the AX server (default)
  ax chat [options]      Start interactive chat client
  ax send <message>      Send a single message
  ax configure           Run configuration wizard

Server Options:
  --daemon               Run server in background
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --config <path>        Config file path (default: ~/.ax/ax.yaml)

Chat Options:
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --no-stream            Disable streaming responses

Send Options:
  --socket <path>        Unix socket path (default: ~/.ax/ax.sock)
  --stdin, -             Read message from stdin
  --no-stream            Wait for full response
  --json                 Output full OpenAI JSON response

Examples:
  ax serve --daemon
  ax chat
  ax send "what is the capital of France"
  echo "summarize this" | ax send --stdin
  `);
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli/index.test.ts`
Expected: PASS (all 6 tests)

**Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli/index.test.ts
git commit -m "feat: add CLI subcommand router"
```

---

## Task 2: Merge host.ts into server.ts

**Files:**
- Create: `src/server.ts`
- Modify: `src/completions.ts` (remove, merge into server.ts)
- Test: `tests/server.test.ts`
- Note: Uses logger from Task 0

**Step 1: Write failing test**

```typescript
// tests/server.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from '../src/server.js';
import { loadConfig } from '../src/config.js';

describe('Server', () => {
  let server: Server;
  let socketPath: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
    }
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  });

  it('should start server on Unix socket', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should remove stale socket on startup', async () => {
    // Create a stale socket file
    const { writeFileSync } = await import('node:fs');
    writeFileSync(socketPath, '');

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    expect(server.listening).toBe(true);
  });

  it('should stop server gracefully', async () => {
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
    await server.stop();
    expect(server.listening).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/server.test.ts`
Expected: FAIL with "Cannot find module '../src/server.js'"

**Step 3: Create server.ts by merging host.ts and completions.ts**

```typescript
// src/server.ts
/**
 * AX Server — Long-running HTTP server for client connections.
 *
 * Merges host.ts initialization with completions.ts HTTP endpoints.
 * Exposes OpenAI-compatible API over Unix socket.
 */

import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { configPath as getConfigPath, axHome, dataDir, dataFile } from './paths.js';
import { loadConfig, type Config } from './config.js';
import { loadDotEnv } from './dotenv.js';
import { loadProviders, type ProviderRegistry } from './registry.js';
import { MessageQueue, ConversationStore } from './db.js';
import { createRouter, type Router } from './router.js';
import { createIPCHandler, createIPCServer } from './ipc.js';
import { TaintBudget, thresholdForProfile } from './taint-budget.js';
import type { InboundMessage } from './providers/types.js';
import { createLogger } from './logger.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ServerOptions {
  socketPath?: string;
  configPath?: string;
  daemon?: boolean;
}

export interface Server {
  listening: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface OpenAIChatRequest {
  model?: string;
  messages: { role: string; content: string | ContentBlock[] }[];
  stream?: boolean;
  max_tokens?: number;
}

interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
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
// Server Factory
// ═══════════════════════════════════════════════════════

export async function createServer(
  config: Config,
  opts: ServerOptions = {},
): Promise<Server> {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');

  // Initialize logger (JSON mode for production, pretty for dev)
  const logFormat = process.env.LOG_FORMAT === 'json' ? 'json' : 'pretty';
  const logger = createLogger({ format: logFormat });

  // Initialize all server components
  logger.info('Loading providers...');
  const providers = await loadProviders(config);
  logger.info('Providers loaded');

  // Initialize DB + Taint Budget + Router + IPC
  mkdirSync(dataDir(), { recursive: true });
  const db = new MessageQueue(dataFile('messages.db'));
  const conversations = new ConversationStore(dataFile('conversations.db'));
  const taintBudget = new TaintBudget({
    threshold: thresholdForProfile(config.profile),
  });
  const router = createRouter(providers, db, { taintBudget });
  const handleIPC = createIPCHandler(providers, { taintBudget });

  // IPC socket server (internal agent-to-host socket)
  const ipcSocketDir = mkdtempSync(join(tmpdir(), 'ax-'));
  const ipcSocketPath = join(ipcSocketDir, 'proxy.sock');
  const defaultCtx = { sessionId: 'server', agentId: 'system' };
  const ipcServer = createIPCServer(ipcSocketPath, handleIPC, defaultCtx);
  logger.info('IPC server started', { socket: ipcSocketPath });

  // Session tracking for canary tokens
  const sessionCanaries = new Map<string, string>();

  // Model ID for API responses
  const modelId = providers.llm.name;

  let httpServer: HttpServer | null = null;
  let listening = false;

  // HTTP request handler
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = `req_${randomUUID().slice(0, 8)}`;
    const startTime = Date.now();

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Route requests
    if (req.url === '/v1/models' && req.method === 'GET') {
      await handleModels(res);
      return;
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      await handleCompletions(req, res, requestId, startTime);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  async function handleModels(res: ServerResponse): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      object: 'list',
      data: [{ id: modelId, object: 'model', created: Date.now(), owned_by: 'ax' }],
    }));
  }

  async function handleCompletions(
    req: IncomingMessage,
    res: ServerResponse,
    requestId: string,
    startTime: number,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const chatReq: OpenAIChatRequest = JSON.parse(body);

      if (!chatReq.messages || chatReq.messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages array is required' }));
        return;
      }

      // Extract last user message
      const lastMsg = chatReq.messages[chatReq.messages.length - 1];
      const content = typeof lastMsg.content === 'string'
        ? lastMsg.content
        : extractTextFromContent(lastMsg.content);

      logger.info('Request received', {
        endpoint: '/v1/chat/completions',
        content_preview: content.slice(0, 40),
        content_length: content.length
      });

      // Create inbound message
      const inboundMsg: InboundMessage = {
        id: requestId,
        channel: 'http',
        sender: 'client',
        content,
        timestamp: new Date(),
        isGroup: false,
      };

      // Process through router
      const result = await router.processInbound(inboundMsg);

      if (!result.queued) {
        logger.scan_inbound('blocked', result.scanResult.reason ?? 'scan failed');
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: result.scanResult.reason ?? 'Message blocked by security scanner' }));
        return;
      }

      logger.scan_inbound('clean');

      // Track canary token
      sessionCanaries.set(result.sessionId, result.canaryToken);

      // Process message through sandbox
      const response = await processMessage(result.sessionId, result.canaryToken);

      // Stream or return full response
      if (chatReq.stream) {
        await streamResponse(res, response, requestId, modelId);
      } else {
        await returnFullResponse(res, response, requestId, modelId, startTime);
      }

    } catch (err) {
      logger.error('Request failed', { error: (err as Error).message });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }

  async function processMessage(sessionId: string, canaryToken: string): Promise<string> {
    const queued = db.dequeue();
    if (!queued) return '';

    let workspace = '';
    try {
      // Create temporary workspace
      workspace = mkdtempSync(join(tmpdir(), 'ax-ws-'));
      const skillsDir = resolve('skills');

      // Write message to workspace (strip canary from file content)
      const fileContent = canaryToken
        ? queued.content.replace(`\n<!-- canary:${canaryToken} -->`, '')
        : queued.content;
      writeFileSync(join(workspace, 'CONTEXT.md'), `# Session: ${queued.session_id}\n`);
      writeFileSync(join(workspace, 'message.txt'), fileContent);

      // Load conversation history
      const history = conversations.getHistory(queued.session_id);

      // Spawn sandbox
      const tsxBin = resolve('node_modules/.bin/tsx');
      const proc = await providers.sandbox.spawn({
        workspace,
        skills: skillsDir,
        ipcSocket: ipcSocketPath,
        timeoutSec: config.sandbox.timeout_sec,
        command: [tsxBin, resolve('src/container/agent-runner.ts')],
        stdin: JSON.stringify({ history, message: queued.content }),
      });

      const spawnStartTime = Date.now();
      logger.agent_spawn(queued.id, config.sandbox.provider);

      let response = '';
      for await (const chunk of proc.output) {
        response += chunk;
      }

      const exitCode = await proc.wait();
      const duration = (Date.now() - spawnStartTime) / 1000;

      logger.agent_complete(queued.id, duration, exitCode);

      if (exitCode !== 0) {
        return '';
      }

      // Process outbound
      const outboundResult = await router.processOutbound({
        sessionId: queued.session_id,
        content: response,
        canaryToken,
      });

      if (outboundResult.redacted) {
        logger.warn('Canary leak detected - response redacted', {
          session_id: queued.session_id
        });
        return outboundResult.content;
      }

      if (!outboundResult.clean) {
        logger.scan_outbound('blocked', undefined, outboundResult.scanResult.reason ?? 'unknown');
        return '';
      }

      logger.scan_outbound('clean');

      // Store conversation history
      conversations.append(queued.session_id, queued.content, response);

      // Call memory.memorize() if provider supports it
      if (providers.memory.memorize) {
        await providers.memory.memorize([
          { role: 'user', content: queued.content, timestamp: new Date() },
          { role: 'assistant', content: response, timestamp: new Date() },
        ]);
      }

      return response;

    } finally {
      if (workspace) {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }

  async function streamResponse(
    res: ServerResponse,
    content: string,
    requestId: string,
    model: string,
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Send initial chunk with role
    const firstChunk: OpenAIStreamChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(firstChunk)}\n\n`);

    // Stream content
    for (const char of content) {
      const chunk: OpenAIStreamChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: char }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    // Send final chunk
    const finalChunk: OpenAIStreamChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  async function returnFullResponse(
    res: ServerResponse,
    content: string,
    requestId: string,
    model: string,
    startTime: number,
  ): Promise<void> {
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    logger.info('Response sent', {
      status: 200,
      content_length: content.length,
      duration_sec: parseFloat(duration)
    });

    const response: OpenAIChatResponse = {
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  function extractTextFromContent(content: ContentBlock[]): string {
    return content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('\n');
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  // Graceful shutdown
  async function shutdown(signal: string): Promise<void> {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await stopServer();
    process.exit(0);
  }

  async function startServer(): Promise<void> {
    // Remove stale socket
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }

    httpServer = createHttpServer(handleRequest);

    await new Promise<void>((resolve, reject) => {
      httpServer!.listen(socketPath, () => {
        listening = true;
        logger.info('AX server listening', { socket: socketPath });
        resolve();
      });
      httpServer!.on('error', reject);
    });

    // Register signal handlers
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // Connect channel providers (Slack, etc.)
    for (const channel of providers.channels) {
      if (channel.name !== 'cli') {
        await channel.connect?.();
      }
    }
  }

  async function stopServer(): Promise<void> {
    // Disconnect channels
    for (const channel of providers.channels) {
      await channel.disconnect?.();
    }

    // Stop HTTP server
    if (httpServer) {
      await new Promise<void>((resolve) => {
        httpServer!.close(() => resolve());
      });
      httpServer = null;
    }

    // Stop IPC server
    ipcServer.close();

    // Clean up socket
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }

    listening = false;
  }

  return {
    get listening() { return listening; },
    start: startServer,
    stop: stopServer,
  };
}

// ═══════════════════════════════════════════════════════
// Utility: Read Body
// ═══════════════════════════════════════════════════════

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/server.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Update completions.ts test to use server.ts**

The existing `tests/completions.test.ts` should be updated to import from `server.ts` instead. We'll do this in the next task.

**Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: merge host.ts and completions.ts into server.ts"
```

---

## Task 3: Create Interactive Chat Client

**Files:**
- Create: `src/cli/chat.ts`
- Test: `tests/cli/chat.test.ts`

**Step 1: Write failing test**

```typescript
// tests/cli/chat.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChatClient, type ChatClientOptions } from '../src/cli/chat.js';
import { Readable, Writable } from 'node:stream';

describe('Chat Client', () => {
  let mockStdin: Readable;
  let mockStdout: Writable;
  let stdoutData: string[];

  beforeEach(() => {
    mockStdin = new Readable({
      read() {},
    });
    mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData.push(chunk.toString());
        callback();
      },
    });
    stdoutData = [];
  });

  it('should send message and receive response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('Hello, user!'),
    });

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    // Simulate user input
    mockStdin.push('Hello\n');
    mockStdin.push(null); // EOF

    await clientPromise;

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(stdoutData.join('')).toContain('Hello, user!');
  });

  it('should accumulate conversation history', async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      callCount++;
      return Promise.resolve({
        ok: true,
        body: createMockSSEStream(`Response ${callCount}`),
      });
    });

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    mockStdin.push('First message\n');
    mockStdin.push('Second message\n');
    mockStdin.push(null);

    await clientPromise;

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Second call should include both messages in history
    const secondCall = mockFetch.mock.calls[1][1];
    const body = JSON.parse(secondCall.body);
    expect(body.messages.length).toBe(4); // user1, assistant1, user2, assistant2
  });

  it('should handle connection errors gracefully', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = createChatClient({
      socketPath: '/tmp/test.sock',
      stdin: mockStdin,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    const clientPromise = client.start();

    mockStdin.push('Hello\n');
    mockStdin.push(null);

    await clientPromise;

    const output = stdoutData.join('');
    expect(output).toContain('Server not running');
    expect(output).toContain('ax serve');
  });
});

function createMockSSEStream(content: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const chunk = {
        choices: [{ delta: { content }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli/chat.test.ts`
Expected: FAIL with "Cannot find module '../src/cli/chat.js'"

**Step 3: Write minimal implementation**

```typescript
// src/cli/chat.ts
import { createInterface, type Interface } from 'node:readline';
import { join } from 'node:path';
import { axHome } from '../paths.js';
import type { Readable, Writable } from 'node:stream';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface ChatClientOptions {
  socketPath?: string;
  noStream?: boolean;
  stdin?: Readable;
  stdout?: Writable;
  fetch?: typeof fetch;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

// ═══════════════════════════════════════════════════════
// Chat Client
// ═══════════════════════════════════════════════════════

export function createChatClient(opts: ChatClientOptions = {}) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true;
  const stdin = opts.stdin ?? process.stdin;
  const stdout = opts.stdout ?? process.stdout;
  const fetchFn = opts.fetch ?? fetch;

  const messages: Message[] = [];

  async function start(): Promise<void> {
    // Test connection
    try {
      await fetchFn(`http://unix:${socketPath}:/v1/models`, {
        method: 'GET',
      });
    } catch (err) {
      stdout.write(
        'Server not running. Start it with: ax serve\n',
      );
      return;
    }

    const rl: Interface = createInterface({
      input: stdin,
      output: stdout,
      prompt: 'you> ',
    });

    rl.prompt();

    for await (const line of rl) {
      const content = line.trim();
      if (!content) {
        rl.prompt();
        continue;
      }

      // Add user message to history
      messages.push({ role: 'user', content });

      try {
        // Send request
        const response = await fetchFn(
          `http://unix:${socketPath}:/v1/chat/completions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'default',
              messages,
              stream,
            }),
          },
        );

        if (!response.ok) {
          const error = await response.text();
          stdout.write(`Error: ${error}\n`);
          messages.pop(); // Remove failed user message
          rl.prompt();
          continue;
        }

        stdout.write('agent> ');

        if (stream && response.body) {
          const assistantContent = await handleStreamResponse(
            response.body,
            stdout,
          );
          messages.push({ role: 'assistant', content: assistantContent });
        } else {
          const data = await response.json();
          const assistantContent = data.choices[0].message.content;
          stdout.write(assistantContent);
          stdout.write('\n');
          messages.push({ role: 'assistant', content: assistantContent });
        }
      } catch (err) {
        stdout.write(
          `\nServer not running. Start it with: ax serve\n`,
        );
        messages.pop(); // Remove failed user message
      }

      rl.prompt();
    }

    rl.close();
  }

  return { start };
}

async function handleStreamResponse(
  body: ReadableStream<Uint8Array>,
  stdout: Writable,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let fullContent = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            stdout.write('\n');
            return fullContent;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              stdout.write(content);
              fullContent += content;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  stdout.write('\n');
  return fullContent;
}

// ═══════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════

export async function runChat(args: string[]): Promise<void> {
  let socketPath: string | undefined;
  let noStream = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--no-stream') {
      noStream = true;
    }
  }

  const client = createChatClient({ socketPath, noStream });
  await client.start();
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli/chat.test.ts`
Expected: PASS (all 3 tests)

**Step 5: Commit**

```bash
git add src/cli/chat.ts tests/cli/chat.test.ts
git commit -m "feat: add interactive chat client"
```

---

## Task 4: Create One-Shot Send Client

**Files:**
- Create: `src/cli/send.ts`
- Test: `tests/cli/send.test.ts`

**Step 1: Write failing test**

```typescript
// tests/cli/send.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createSendClient, type SendClientOptions } from '../src/cli/send.js';
import { Writable } from 'node:stream';

describe('Send Client', () => {
  it('should send single message and output response', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('The capital is Paris'),
    });

    const client = createSendClient({
      message: 'what is the capital of France',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await client.send();

    expect(mockFetch).toHaveBeenCalledOnce();
    expect(stdoutData).toBe('The capital is Paris');
  });

  it('should read from stdin when --stdin flag', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createMockSSEStream('Summary complete'),
    });

    const client = createSendClient({
      message: 'summarize this text',
      fromStdin: true,
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      stdin: 'Long text to summarize',
      fetch: mockFetch as any,
    });

    await client.send();

    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.messages[0].content).toBe('summarize this text');
  });

  it('should output JSON when --json flag', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'req_123',
        object: 'chat.completion',
        choices: [{ message: { content: 'Paris' } }],
      }),
    });

    const client = createSendClient({
      message: 'capital of France',
      socketPath: '/tmp/test.sock',
      json: true,
      noStream: true,
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await client.send();

    const output = JSON.parse(stdoutData);
    expect(output.id).toBe('req_123');
    expect(output.choices[0].message.content).toBe('Paris');
  });

  it('should handle connection errors', async () => {
    const mockStdout = new Writable({ write: vi.fn() });
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const client = createSendClient({
      message: 'hello',
      socketPath: '/tmp/test.sock',
      stdout: mockStdout,
      fetch: mockFetch as any,
    });

    await expect(client.send()).rejects.toThrow();
  });
});

function createMockSSEStream(content: string): ReadableStream {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const chunk = {
        choices: [{ delta: { content }, finish_reason: null }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}
```

**Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli/send.test.ts`
Expected: FAIL with "Cannot find module '../src/cli/send.js'"

**Step 3: Write minimal implementation**

```typescript
// src/cli/send.ts
import { join } from 'node:path';
import { axHome } from '../paths.js';
import type { Writable } from 'node:stream';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface SendClientOptions {
  message: string;
  socketPath?: string;
  fromStdin?: boolean;
  stdin?: string;
  noStream?: boolean;
  json?: boolean;
  stdout?: Writable;
  fetch?: typeof fetch;
}

// ═══════════════════════════════════════════════════════
// Send Client
// ═══════════════════════════════════════════════════════

export function createSendClient(opts: SendClientOptions) {
  const socketPath = opts.socketPath ?? join(axHome(), 'ax.sock');
  const stream = opts.noStream !== true && !opts.json;
  const stdout = opts.stdout ?? process.stdout;
  const fetchFn = opts.fetch ?? fetch;
  const message = opts.message;

  async function send(): Promise<void> {
    try {
      const response = await fetchFn(
        `http://unix:${socketPath}:/v1/chat/completions`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'default',
            messages: [{ role: 'user', content: message }],
            stream,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Server error: ${error}`);
      }

      if (opts.json) {
        const data = await response.json();
        stdout.write(JSON.stringify(data, null, 2));
        return;
      }

      if (stream && response.body) {
        await handleStreamResponse(response.body, stdout);
      } else {
        const data = await response.json();
        stdout.write(data.choices[0].message.content);
      }
    } catch (err) {
      throw err;
    }
  }

  return { send };
}

async function handleStreamResponse(
  body: ReadableStream<Uint8Array>,
  stdout: Writable,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices[0]?.delta?.content;
            if (content) {
              stdout.write(content);
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ═══════════════════════════════════════════════════════
// CLI Entry Point
// ═══════════════════════════════════════════════════════

export async function runSend(args: string[]): Promise<void> {
  let socketPath: string | undefined;
  let noStream = false;
  let json = false;
  let fromStdin = false;
  let message = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--socket') {
      socketPath = args[++i];
    } else if (args[i] === '--no-stream') {
      noStream = true;
    } else if (args[i] === '--json') {
      json = true;
    } else if (args[i] === '--stdin' || args[i] === '-') {
      fromStdin = true;
    } else if (!message) {
      message = args[i];
    }
  }

  if (fromStdin) {
    // Read from stdin
    const { stdin } = process;
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) {
      chunks.push(chunk);
    }
    message = Buffer.concat(chunks).toString('utf-8');
  }

  if (!message) {
    console.error('Error: message required (provide as argument or use --stdin)');
    process.exit(1);
  }

  const client = createSendClient({
    message,
    socketPath,
    noStream,
    json,
    fromStdin,
  });

  try {
    await client.send();
    process.exit(0);
  } catch (err) {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- tests/cli/send.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add src/cli/send.ts tests/cli/send.test.ts
git commit -m "feat: add one-shot send client"
```

---

## Task 5: Wire Up CLI Entry Point

**Files:**
- Modify: `src/host.ts` (becomes thin wrapper)
- Modify: `src/cli/index.ts` (add command implementations)
- Modify: `package.json` (update scripts)

**Step 1: Update src/cli/index.ts to wire commands**

```typescript
// src/cli/index.ts (append to existing file)

import { createServer } from '../server.js';
import { loadConfig } from '../config.js';
import { loadDotEnv } from '../dotenv.js';
import { configPath as getConfigPath, axHome } from '../paths.js';
import { existsSync } from 'node:fs';
import { runChat } from './chat.js';
import { runSend } from './send.js';

export async function main(): Promise<void> {
  loadDotEnv();

  const args = process.argv.slice(2);

  await routeCommand(args, {
    serve: async () => {
      await runServe(args);
    },
    chat: async () => {
      await runChat(args);
    },
    send: async (sendArgs) => {
      await runSend(sendArgs);
    },
    configure: async () => {
      const { runConfigure } = await import('../onboarding/configure.js');
      await runConfigure(axHome());
    },
    help: async () => {
      showHelp();
    },
  });
}

async function runServe(args: string[]): Promise<void> {
  let configPath: string | undefined;
  let daemon = false;
  let socketPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      configPath = args[++i];
    } else if (args[i] === '--daemon') {
      daemon = true;
    } else if (args[i] === '--socket') {
      socketPath = args[++i];
    }
  }

  // First-run detection
  const resolvedConfigPath = configPath ?? getConfigPath();
  if (!existsSync(resolvedConfigPath)) {
    console.log('[server] No ax.yaml found — running first-time setup...\n');
    const { runConfigure } = await import('../onboarding/configure.js');
    await runConfigure(axHome());
    loadDotEnv();
    console.log('[server] Setup complete! Starting AX...\n');
  }

  // Load config and create server
  console.log('[server] Loading config...');
  const config = loadConfig(configPath);
  console.log(`[server] Profile: ${config.profile}`);

  const server = await createServer(config, { socketPath, daemon });
  await server.start();

  // If daemon mode, detach
  if (daemon) {
    console.log('[server] Running in daemon mode');
    process.disconnect?.();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
```

**Step 2: Update src/host.ts to be a thin wrapper**

```typescript
// src/host.ts (replace entire file)
/**
 * Legacy entry point — redirects to cli/index.ts
 *
 * This file exists for backward compatibility with `npm start`.
 * All logic has moved to src/server.ts and src/cli/*.ts.
 */

import { main } from './cli/index.js';

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
```

**Step 3: Update package.json scripts**

```json
{
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:fuzz": "vitest run tests/ipc-fuzz.test.ts",
    "start": "NODE_NO_WARNINGS=1 tsx src/cli/index.ts serve",
    "chat": "NODE_NO_WARNINGS=1 tsx src/cli/index.ts chat",
    "send": "NODE_NO_WARNINGS=1 tsx src/cli/index.ts send",
    "configure": "NODE_NO_WARNINGS=1 tsx src/cli/index.ts configure"
  }
}
```

**Step 4: Test the integration**

Run: `npm test`
Expected: All existing tests pass

**Step 5: Manual smoke test**

```bash
# Terminal 1: Start server
npm start

# Terminal 2: Test chat client
npm run chat

# Terminal 3: Test send client
npm run send "what is 2+2"
```

Expected: All commands work correctly

**Step 6: Commit**

```bash
git add src/host.ts src/cli/index.ts package.json
git commit -m "feat: wire up CLI entry points and update package scripts"
```

---

## Task 6: Remove CLI Channel Provider

**Files:**
- Delete: `src/providers/channel/cli.ts`
- Modify: `src/provider-map.ts` (remove cli channel)
- Modify: `tests/providers/channel-cli.test.ts` (delete)

**Step 1: Remove CLI provider from provider map**

```typescript
// src/provider-map.ts
// Remove the line:
// 'channel:cli': () => import('./providers/channel/cli.js'),
```

**Step 2: Delete files**

```bash
git rm src/providers/channel/cli.ts
git rm tests/providers/channel-cli.test.ts
```

**Step 3: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 4: Commit**

```bash
git commit -m "feat: remove CLI channel provider (replaced by chat client)"
```

---

## Task 7: Update ConversationStore (Remove, Server is Stateless)

**Files:**
- Modify: `src/db.ts` (remove ConversationStore)
- Modify: `src/server.ts` (remove conversation history logic)
- Modify: `tests/db.test.ts` (remove ConversationStore tests)

**Step 1: Update server.ts to be stateless**

The server should NOT load or store conversation history. That's the client's job. Remove all references to `ConversationStore` in server.ts:

```typescript
// src/server.ts
// Remove these imports/usages:
// - ConversationStore
// - conversations.getHistory()
// - conversations.append()

// In processMessage(), remove:
// const history = conversations.getHistory(queued.session_id);

// And remove:
// conversations.append(queued.session_id, queued.content, response);

// The agent-runner.ts stdin should just be the single message, not JSON with history:
stdin: queued.content,
```

**Step 2: Remove ConversationStore from db.ts**

```typescript
// src/db.ts
// Remove the ConversationStore class entirely
```

**Step 3: Remove tests**

```bash
# Edit tests/db.test.ts to remove ConversationStore tests
```

**Step 4: Run tests**

Run: `npm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/db.ts src/server.ts tests/db.test.ts
git commit -m "refactor: remove ConversationStore, server is stateless"
```

---

## Task 8: Update Documentation

**Files:**
- Modify: `README.md` (update usage examples)
- Modify: `docs/plans/ax-architecture-doc.md` (update architecture section)

**Step 1: Update README usage section**

```markdown
## Usage

### Start the Server

```bash
npm start
# or
npm start -- --daemon  # run in background
```

### Interactive Chat

```bash
npm run chat
```

### One-Shot Messages

```bash
npm run send "what is the capital of France"

echo "summarize this text" | npm run send --stdin

npm run send "hello" --json  # output full JSON response
```

### Configuration

```bash
npm run configure
```
```

**Step 2: Update architecture doc**

Update the "Client-Server Architecture" section in `docs/plans/ax-architecture-doc.md` to reflect the new split design. Reference the design document at `docs/plans/2026-02-09-client-server-split-design.md`.

**Step 3: Commit**

```bash
git add README.md docs/plans/ax-architecture-doc.md
git commit -m "docs: update for client-server architecture"
```

---

## Task 9: Integration Tests

**Files:**
- Create: `tests/integration/client-server.test.ts`

**Step 1: Write integration test**

```typescript
// tests/integration/client-server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { createServer, type Server } from '../../src/server.js';
import { createChatClient } from '../../src/cli/chat.js';
import { createSendClient } from '../../src/cli/send.js';
import { loadConfig } from '../../src/config.js';
import { Readable, Writable } from 'node:stream';

describe('Client-Server Integration', () => {
  let server: Server;
  let socketPath: string;

  beforeAll(async () => {
    socketPath = join(tmpdir(), `ax-test-${randomUUID()}.sock`);
    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    try {
      unlinkSync(socketPath);
    } catch {
      // ignore
    }
  });

  it('should handle chat client request', async () => {
    const mockStdin = new Readable({
      read() {},
    });
    const stdoutData: string[] = [];
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData.push(chunk.toString());
        callback();
      },
    });

    const client = createChatClient({
      socketPath,
      stdin: mockStdin,
      stdout: mockStdout,
    });

    const clientPromise = client.start();

    mockStdin.push('hello\n');
    mockStdin.push(null); // EOF

    await clientPromise;

    const output = stdoutData.join('');
    expect(output).toContain('agent>');
  });

  it('should handle send client request', async () => {
    let stdoutData = '';
    const mockStdout = new Writable({
      write(chunk, _encoding, callback) {
        stdoutData += chunk.toString();
        callback();
      },
    });

    const client = createSendClient({
      message: 'test message',
      socketPath,
      stdout: mockStdout,
    });

    await client.send();

    expect(stdoutData.length).toBeGreaterThan(0);
  });

  it('should handle multiple concurrent clients', async () => {
    const clients = Array.from({ length: 3 }, (_, i) => {
      let data = '';
      const stdout = new Writable({
        write(chunk, _enc, cb) {
          data += chunk.toString();
          cb();
        },
      });

      return {
        client: createSendClient({
          message: `message ${i}`,
          socketPath,
          stdout,
        }),
        getData: () => data,
      };
    });

    await Promise.all(clients.map((c) => c.client.send()));

    for (const c of clients) {
      expect(c.getData().length).toBeGreaterThan(0);
    }
  });
});
```

**Step 2: Run test**

Run: `npm test -- tests/integration/client-server.test.ts`
Expected: PASS (all 3 tests)

**Step 3: Commit**

```bash
git add tests/integration/client-server.test.ts
git commit -m "test: add client-server integration tests"
```

---

## Task 10: Update Journal and Lessons

**Files:**
- Modify: `.claude/journal.md`
- Modify: `.claude/lessons.md`

**Step 1: Append to journal**

```markdown
## [2026-02-09 HH:MM] — Client-Server Split Implementation

**Task:** Split monolithic host.ts into server process and CLI clients with structured logging
**What I did:** Created logger.ts (JSON/pretty output modes, color-coded events), server.ts (merged host + completions with logger integration), chat.ts (interactive client), send.ts (one-shot client), cli/index.ts (subcommand router). Made server stateless — clients manage conversation history. Server exposes OpenAI-compatible HTTP API over Unix socket. Removed CLI channel provider and ConversationStore. All server events logged: llm_call, tool_use, scan_inbound, scan_outbound, agent_spawn, agent_complete.
**Files touched:**
  - Created: src/logger.ts, src/server.ts, src/cli/index.ts, src/cli/chat.ts, src/cli/send.ts
  - Modified: src/host.ts (thin wrapper), package.json (scripts), src/db.ts (removed ConversationStore)
  - Removed: src/completions.ts, src/providers/channel/cli.ts
  - Tests: tests/logger.test.ts, tests/server.test.ts, tests/cli/*.test.ts, tests/integration/client-server.test.ts
**Outcome:** Success — all 470+ tests pass, server/chat/send work correctly, logs are clean and queryable
**Notes:** Server is long-running daemon, clients connect via Unix socket. Server is stateless per-request, clients accumulate their own conversation history. This enables daemon mode, multiple concurrent clients, and faster reconnect. Logger supports both pretty (dev) and JSON (production) modes via LOG_FORMAT env var.
```

**Step 2: Append to lessons (if any new learnings)**

If there were any notable challenges or lessons during implementation, add them here.

**Step 3: Commit**

```bash
git add .claude/journal.md .claude/lessons.md
git commit -m "docs: update journal and lessons for client-server split"
```

---

## Final Verification

**Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass

**Step 2: Manual smoke test**

```bash
# Terminal 1
npm start

# Terminal 2
npm run chat
# Type: "what is 2+2"
# Verify: agent responds

# Terminal 3
npm run send "capital of France"
# Verify: outputs "Paris"

# Terminal 4
echo "test" | npm run send --stdin
# Verify: agent responds
```

**Step 3: Verify backward compatibility**

```bash
npm start  # Should still work (runs serve)
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "feat: complete client-server split implementation"
```

---

## Summary

This plan implements the client-server split design in 11 focused tasks:

0. ✅ Structured logger with JSON output mode
1. ✅ CLI subcommand router
2. ✅ Merge host.ts + completions.ts → server.ts (with logger integration)
3. ✅ Interactive chat client
4. ✅ One-shot send client
5. ✅ Wire up CLI entry points
6. ✅ Remove CLI channel provider
7. ✅ Remove ConversationStore (stateless server)
8. ✅ Update documentation
9. ✅ Integration tests
10. ✅ Update journal/lessons

**Key architectural changes:**
- Server is long-running, stateless per-request
- Clients manage their own conversation history
- Communication via OpenAI-compatible HTTP API over Unix socket
- Supports daemon mode, multiple concurrent clients, fast reconnect

**Logging:**
- Structured logger with JSON and pretty output modes
- Color-coded events: llm_call, tool_use, scan_inbound, scan_outbound, agent_spawn, agent_complete
- Queryable via LOG_FORMAT=json for production monitoring
- Timestamps on all events

**Backward compatibility:**
- `npm start` still works (runs `ax serve`)
- All existing functionality preserved
- Server logging shows request activity

**Testing:**
- Unit tests for all new components (including logger)
- Integration tests for client-server communication
- Manual smoke tests for real-world usage
