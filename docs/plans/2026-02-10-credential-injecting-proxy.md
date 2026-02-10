# Credential-Injecting Proxy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the current IPC-based LLM routing and broken OAuth forwarding with a credential-injecting HTTP proxy that works for all agent types (claude-code and pi-coding-agent), supporting both API key and OAuth authentication.

**Architecture:** The proxy listens on a Unix socket, receives Anthropic Messages API requests from agents with a dummy API key, strips the dummy key, injects real credentials (either `x-api-key` or `Authorization: Bearer`), and forwards to `api.anthropic.com`. Agents never see real credentials. The proxy runs on the host side. IPC remains for non-LLM actions (memory, web, audit).

**Tech Stack:** Node.js HTTP server, Anthropic SDK, Unix sockets, undici Agent

---

## Current Architecture (What Changes)

**Before:** Two paths for LLM calls:
1. `pi-agent-core` / `pi-coding-agent` → IPC `llm_call` → host `providers.llm.chat()` → Anthropic API (batch, 30s-timeout issues)
2. `claude-code` → HTTP proxy socket → IPC `llm_call` → same host path (double translation)
3. OAuth mode → HTTP proxy → forward to api.anthropic.com (broken: 401 error)

**After:** One path for all agents:
- All agents → HTTP proxy socket → credential injection → Anthropic API (direct, streaming)
- IPC remains for memory, web, audit, skills, browser actions

**Files overview:**
| File | Action |
|------|--------|
| `src/anthropic-proxy.ts` | **Rewrite** — credential-injecting forward proxy |
| `src/server.ts` | **Modify** — start proxy for all agent types, not just claude-code |
| `src/container/agents/pi-session.ts` | **Modify** — use Anthropic SDK via proxy instead of IPC for LLM |
| `src/container/agents/claude-code.ts` | **Minor** — already uses proxy, just verify |
| `src/container/agent-runner.ts` | **Minor** — pass proxy socket to pi-session |
| `src/providers/llm/anthropic.ts` | **Modify** — remove OAuth stub, always require credentials on host |
| `src/providers/sandbox/seatbelt.ts` | **Modify** — pass proxy socket path to sandbox |
| `policies/agent.sb` | **Modify** — allow proxy socket access |
| `tests/anthropic-proxy.test.ts` | **Rewrite** — test credential injection |
| `tests/container/agents/pi-session.test.ts` | **Modify** — test proxy-based LLM calls |

---

### Task 1: Rewrite anthropic-proxy.ts as a Credential-Injecting Forward Proxy

**Files:**
- Modify: `src/anthropic-proxy.ts`
- Test: `tests/anthropic-proxy.test.ts`

The proxy becomes a single-mode forward proxy that:
1. Listens on a Unix socket
2. Receives `POST /v1/messages` from agents (with dummy `x-api-key`)
3. Strips the dummy key
4. Injects real credentials from `process.env` (API key or OAuth token)
5. Forwards to `https://api.anthropic.com/v1/messages`
6. Streams the response back to the agent

**Step 1: Write failing tests for credential-injecting proxy**

Replace the contents of `tests/anthropic-proxy.test.ts` with:

```typescript
import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startAnthropicProxy } from '../src/anthropic-proxy.js';

describe('Credential-Injecting Proxy', () => {
  let tmpDir: string;
  let mockApi: Server;
  let proxyResult: { server: Server; stop: () => void };
  const mockApiPort = 19901;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
  });

  afterEach(() => {
    proxyResult?.stop();
    mockApi?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  function startMockApi(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<void> {
    return new Promise((resolve) => {
      mockApi = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        handler(req, Buffer.concat(chunks).toString(), res);
      });
      mockApi.listen(mockApiPort, resolve);
    });
  }

  test('injects x-api-key when ANTHROPIC_API_KEY is set', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    await startMockApi((req, body, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-5-20250929', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-real-key-123';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${mockApiPort}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    // Proxy must replace dummy key with real key
    expect(receivedHeaders['x-api-key']).toBe('sk-ant-real-key-123');
    // Must NOT have Authorization header
    expect(receivedHeaders['authorization']).toBeUndefined();
  });

  test('injects Bearer token when CLAUDE_CODE_OAUTH_TOKEN is set (no API key)', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    await startMockApi((req, body, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-5-20250929', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-token-xyz';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${mockApiPort}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    // Proxy must inject Bearer token
    expect(receivedHeaders['authorization']).toBe('Bearer sk-ant-oat01-token-xyz');
    // Must NOT have x-api-key
    expect(receivedHeaders['x-api-key']).toBeUndefined();
  });

  test('streams SSE responses through', async () => {
    await startMockApi((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${mockApiPort}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929', max_tokens: 100, stream: true,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const text = await response.text();
    expect(text).toContain('message_start');
    expect(text).toContain('hello');
    expect(text).toContain('message_stop');
  });

  test('returns 404 for non-messages endpoints', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${mockApiPort}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/models', {
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(404);
  });

  test('API key takes precedence over OAuth token', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    await startMockApi((req, _body, res) => {
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        model: 'claude-sonnet-4-5-20250929', stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-real';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-token';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${mockApiPort}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'dummy' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
        messages: [{ role: 'user', content: 'Hi' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(receivedHeaders['x-api-key']).toBe('sk-ant-real');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/anthropic-proxy.test.ts`
Expected: FAIL — `startAnthropicProxy` signature changed (now takes `targetUrl` instead of `ipcSocketPath`)

**Step 3: Rewrite src/anthropic-proxy.ts**

Replace the entire contents of `src/anthropic-proxy.ts` with:

```typescript
/**
 * Credential-injecting forward proxy for the Anthropic Messages API.
 *
 * Listens on a Unix socket. Agents send standard Anthropic API requests
 * with a dummy x-api-key. The proxy strips the dummy key, injects real
 * credentials from the host environment, and forwards to the Anthropic API.
 *
 * Supports both API key and OAuth token authentication:
 * - ANTHROPIC_API_KEY → x-api-key header (takes precedence)
 * - CLAUDE_CODE_OAUTH_TOKEN → Authorization: Bearer header
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, unlinkSync } from 'node:fs';

const DEFAULT_TARGET = 'https://api.anthropic.com';

export function startAnthropicProxy(
  proxySocketPath: string,
  targetBaseUrl?: string,
): { server: Server; stop: () => void } {
  const target = targetBaseUrl ?? DEFAULT_TARGET;

  // Clean up stale socket
  if (existsSync(proxySocketPath)) {
    unlinkSync(proxySocketPath);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Only forward POST /v1/messages
    if (req.url !== '/v1/messages' || req.method !== 'POST') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'Not found' } }));
      return;
    }

    try {
      const body = await readBody(req);
      await forwardWithCredentials(target, body, req, res);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
      }
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'api_error', message: (err as Error).message },
      }));
    }
  });

  server.listen(proxySocketPath);

  return {
    server,
    stop: () => {
      server.close();
      try { unlinkSync(proxySocketPath); } catch { /* ignore */ }
    },
  };
}

/**
 * Forward the request to the Anthropic API with real credentials injected.
 * Streams the response back to the agent.
 */
async function forwardWithCredentials(
  targetBaseUrl: string,
  body: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

  // Build outbound headers — copy from agent, then replace auth
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value || key === 'host' || key === 'connection' || key === 'content-length') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }

  // Inject real credentials (API key takes precedence over OAuth)
  if (apiKey) {
    headers.set('x-api-key', apiKey);
    headers.delete('authorization');
  } else if (oauthToken) {
    headers.set('authorization', `Bearer ${oauthToken}`);
    headers.delete('x-api-key');
  }

  const response = await fetch(`${targetBaseUrl}/v1/messages`, {
    method: 'POST',
    headers,
    body,
  });

  // Forward status + headers back to agent
  const outHeaders: Record<string, string> = {};
  response.headers.forEach((v, k) => {
    if (k !== 'transfer-encoding') outHeaders[k] = v;
  });
  res.writeHead(response.status, outHeaders);

  // Stream response body through
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const MAX_BODY = 4 * 1024 * 1024; // 4MB
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/anthropic-proxy.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/anthropic-proxy.ts tests/anthropic-proxy.test.ts
git commit -m "refactor: rewrite anthropic-proxy as credential-injecting forward proxy"
```

---

### Task 2: Update server.ts to Start Proxy for All Agent Types

**Files:**
- Modify: `src/server.ts` (lines 327-342)

Currently the proxy only starts for `claude-code` agent type. All agents should use it.

**Step 1: Write failing test** — Not needed (existing integration tests will verify). This is a config wiring change.

**Step 2: Modify server.ts**

In `src/server.ts`, change the proxy startup block (lines 327-333) from:

```typescript
// Start Anthropic proxy for claude-code agent (translates Messages API → IPC)
let proxySocketPath: string | undefined;
if (agentType === 'claude-code') {
  proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
  const proxy = startAnthropicProxy(proxySocketPath, ipcSocketPath);
  proxyCleanup = proxy.stop;
}
```

To:

```typescript
// Start credential-injecting proxy for all agents
// Agents send Anthropic API requests with dummy key → proxy injects real credentials
const proxySocketPath = join(ipcSocketDir, 'anthropic-proxy.sock');
const proxy = startAnthropicProxy(proxySocketPath);
proxyCleanup = proxy.stop;
```

Also update the spawn command (line 342) — proxy socket is now always passed:

Change:
```typescript
...(proxySocketPath ? ['--proxy-socket', proxySocketPath] : []),
```

To:
```typescript
'--proxy-socket', proxySocketPath,
```

**Step 3: Update the `startAnthropicProxy` import** — verify `ipcSocketPath` is no longer used in the call (the new signature is `startAnthropicProxy(proxySocketPath, targetBaseUrl?)`).

**Step 4: Run tests**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (may need minor updates if server tests reference old proxy behavior)

**Step 5: Commit**

```bash
git add src/server.ts
git commit -m "feat: start credential-injecting proxy for all agent types"
```

---

### Task 3: Update pi-session.ts to Use Proxy Instead of IPC for LLM Calls

**Files:**
- Modify: `src/container/agents/pi-session.ts`
- Modify: `src/container/agent-runner.ts` (pass proxySocket to pi-session)
- Test: `tests/container/agents/pi-session.test.ts`

This is the biggest change. Instead of routing LLM calls through IPC (`createIPCStreamFunction`), pi-session will use the Anthropic SDK pointed at the proxy socket.

**Step 1: Write failing test for proxy-based pi-session LLM calls**

Add a test to `tests/container/agents/pi-session.test.ts` that verifies pi-session sends LLM requests to the proxy socket.

```typescript
test('routes LLM calls through proxy socket instead of IPC', async () => {
  // Setup: mock HTTP server on a Unix socket that returns Anthropic API response
  // Verify: pi-session sends POST /v1/messages to the proxy
  // Verify: IPC is NOT called for llm_call
});
```

**Step 2: Modify agent-runner.ts**

In `src/container/agent-runner.ts`, ensure `proxySocket` is forwarded to `runPiSession`:

The `AgentConfig` interface already has `proxySocket?: string`. The arg parser already reads `--proxy-socket`. Just verify `runPiSession(config)` receives it — it should already work since the full config is passed.

**Step 3: Rewrite pi-session.ts LLM routing**

Replace the IPC-based stream function with an Anthropic SDK client pointing to the proxy. Key changes:

1. Replace `createIPCStreamFunction(client)` with a new `createProxyStreamFunction(proxySocket)` that:
   - Creates an Anthropic SDK client with `apiKey: 'dummy'`, `baseURL: 'http://localhost'`, `fetch: socketFetch`
   - Calls `anthropic.messages.stream()` which handles SSE parsing
   - Converts Anthropic SDK events to pi-ai `AssistantMessageEventStream` events

2. Keep IPC for non-LLM tools (memory, web, audit) — the `createIPCToolDefinitions(client)` stays unchanged.

In `src/container/agents/pi-session.ts`, replace the IPC stream setup (lines 400-419):

```typescript
// FROM:
clearApiProviders();
const ipcStreamFn = createIPCStreamFunction(client);
registerApiProvider({
  api: 'ax-ipc',
  stream: ipcStreamFn,
  streamSimple: ipcStreamFn,
});

// TO:
clearApiProviders();
const proxyStreamFn = createProxyStreamFunction(config.proxySocket!);
registerApiProvider({
  api: 'ax-proxy',
  stream: proxyStreamFn,
  streamSimple: proxyStreamFn,
});
```

And add the new stream function:

```typescript
function createProxyStreamFunction(proxySocket: string) {
  return (model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      try {
        const Anthropic = (await import('@anthropic-ai/sdk')).default;
        const { Agent } = await import('undici');
        const dispatcher = new Agent({ connect: { socketPath: proxySocket } });
        const anthropic = new Anthropic({
          apiKey: 'dummy',
          baseURL: 'http://localhost',
          fetch: ((input: string | URL | Request, init?: RequestInit) =>
            fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch,
        });

        // Convert pi-ai messages to Anthropic format
        const messages = convertToAnthropicMessages(context.messages);
        const tools = convertToAnthropicTools(context.tools);

        const apiStream = anthropic.messages.stream({
          model: model.id,
          max_tokens: options?.maxTokens ?? model.maxTokens ?? 8192,
          system: context.systemPrompt || undefined,
          messages,
          ...(tools.length ? { tools } : {}),
        });

        // Convert Anthropic SDK streaming events to pi-ai events
        // ... (event mapping code)

        const finalMessage = await apiStream.finalMessage();
        // Build pi-ai AssistantMessage from finalMessage
        // Push done event
      } catch (err) {
        // Push error event
      }
    })();

    return stream;
  };
}
```

Also update the model definition:
```typescript
// Change api from 'ax-ipc' to 'ax-proxy'
function createProxyModel(maxTokens?: number): Model<any> {
  return {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5 (via Proxy)',
    api: 'ax-proxy',
    provider: 'ax',
    baseUrl: 'http://localhost',
    // ... rest stays the same
  };
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/container/agents/pi-session.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/container/agents/pi-session.ts src/container/agent-runner.ts tests/container/agents/pi-session.test.ts
git commit -m "feat: route pi-session LLM calls through credential-injecting proxy"
```

---

### Task 4: Update Seatbelt Sandbox to Allow Proxy Socket

**Files:**
- Modify: `policies/agent.sb`
- Modify: `src/providers/sandbox/seatbelt.ts`

The proxy runs on a Unix socket in the IPC socket directory. The seatbelt sandbox already allows the IPC socket, but the proxy socket is a separate file. We need to allow the whole IPC socket directory.

**Step 1: Update policies/agent.sb**

The IPC socket line (line 19) currently allows only the exact IPC socket path:
```
(allow file-read* file-write* (literal (param "IPC_SOCKET")))
(allow network-outbound (remote unix-socket (literal (param "IPC_SOCKET"))))
```

Change to allow the entire IPC socket directory (which contains both `ipc.sock` and `anthropic-proxy.sock`):

```
;; ── IPC + proxy sockets (communication channels to host) ──
(allow file-read* file-write* (subpath (param "IPC_SOCKET_DIR")))
(allow network-outbound (remote unix-socket (subpath (param "IPC_SOCKET_DIR"))))
```

**Step 2: Update seatbelt.ts to pass directory**

In `src/providers/sandbox/seatbelt.ts`, change the `-D` parameter from socket file to directory:

```typescript
// FROM:
'-D', `IPC_SOCKET=${config.ipcSocket}`,

// TO:
'-D', `IPC_SOCKET_DIR=${dirname(config.ipcSocket)}`,
```

And import `dirname` from `node:path`.

Also add the proxy socket path to the env vars passed to the sandbox if it's available through config. However, looking at the `SandboxConfig` interface, it only has `ipcSocket`. The proxy socket is in the same directory, so the agent just needs to know about it (passed via `--proxy-socket` CLI arg, which is already happening in server.ts).

**Step 3: Run seatbelt smoke test**

Run: `npx vitest run tests/integration/smoke.test.ts`
Expected: PASS (on macOS)

**Step 4: Commit**

```bash
git add policies/agent.sb src/providers/sandbox/seatbelt.ts
git commit -m "fix: allow proxy socket access in seatbelt sandbox"
```

---

### Task 5: Update anthropic.ts LLM Provider (Remove OAuth Stub)

**Files:**
- Modify: `src/providers/llm/anthropic.ts` (lines 29-37)
- Test: existing tests should cover this

The OAuth stub in the LLM provider was a workaround for when the proxy handled OAuth directly. Now the proxy handles ALL auth, and the host-side LLM provider is only used by IPC `llm_call` for agents that still use IPC for LLM (currently none, but keep it as fallback).

**Step 1: Simplify the provider**

Since all agents now route LLM calls through the proxy, the host-side LLM provider is only needed for IPC fallback. Allow it to work with either API key or OAuth token:

```typescript
// FROM (lines 29-37):
if (!apiKey && oauthToken && config.agent === 'claude-code') {
  return {
    name: 'anthropic',
    async *chat(): AsyncIterable<ChatChunk> {
      throw new Error('LLM provider not available — claude-code uses OAuth proxy');
    },
    async models() { return []; },
  };
}

// TO:
// No API key AND no OAuth token → error
// With OAuth but no API key → proxy handles auth, LLM provider is unused
// Return a stub that points users to the proxy
if (!apiKey) {
  if (oauthToken) {
    // OAuth auth — agents route LLM calls through credential-injecting proxy.
    // Host-side LLM provider is not used. Return stub.
    return {
      name: 'anthropic',
      async *chat(): AsyncIterable<ChatChunk> {
        throw new Error('LLM calls route through credential-injecting proxy — this provider is unused');
      },
      async models() { return []; },
    };
  }
  throw new Error(
    'ANTHROPIC_API_KEY environment variable is required.\n' +
    'Set it with: export ANTHROPIC_API_KEY=sk-ant-...',
  );
}
```

**Step 2: Run tests**

Run: `npx vitest run tests/providers/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/llm/anthropic.ts
git commit -m "refactor: simplify LLM provider OAuth handling"
```

---

### Task 6: Clean Up — Remove IPC llm_call Dead Code

**Files:**
- Modify: `src/ipc.ts` — keep `llm_call` handler but add a deprecation note (may still be used as fallback)
- Delete: `src/container/ipc-transport.ts` — no longer needed (LLM calls go through proxy)
- Modify: `src/container/agent-runner.ts` — remove `ipc-transport.ts` import
- Clean up: `tests/container/ipc-transport.test.ts` — delete
- Clean up: `tests/proxy-poc/` — delete POC test directory

**Step 1: Verify no other files import ipc-transport.ts**

Run: `grep -r 'ipc-transport' src/`
Expected: only `agent-runner.ts` imports it (for `createIPCStreamFn`)

**Step 2: Remove ipc-transport.ts usage from agent-runner.ts**

The `pi-agent-core` runner in `agent-runner.ts` currently uses `createIPCStreamFn` from `ipc-transport.ts`. It should be updated to use the proxy-based stream function instead (similar to what we did for pi-session in Task 3).

If `pi-agent-core` agent type is still in use, update it to use the proxy. If it's been superseded by `pi-coding-agent`, consider removing it entirely.

**Step 3: Delete unused files and tests**

```bash
rm src/container/ipc-transport.ts tests/container/ipc-transport.test.ts
rm -rf tests/proxy-poc/
```

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove IPC LLM transport (replaced by credential-injecting proxy)"
```

---

### Task 7: Integration Testing

**Files:**
- Modify: `tests/integration/smoke.test.ts` — verify proxy works end-to-end

**Step 1: Update smoke tests**

Add/update smoke test to verify:
1. Agent process starts and sends LLM request through proxy
2. Proxy injects credentials and forwards to API
3. Response streams back to agent

**Step 2: Run full test suite and smoke tests**

```bash
npx vitest run
npx vitest run tests/integration/smoke.test.ts
```

**Step 3: Manual verification**

Test with the actual user's OAuth configuration:
```bash
npm start
# Send a message and verify the agent responds (no 401 error)
```

**Step 4: Commit**

```bash
git add tests/integration/
git commit -m "test: add integration tests for credential-injecting proxy"
```

---

## Security Analysis

**Preserved invariants:**
- Credentials never enter sandbox environment (proxy runs on host)
- No network access from sandbox (seatbelt/nsjail deny IP)
- All communication via Unix sockets
- IPC still used for memory, web, audit, skills (unchanged)
- Audit logging still works (IPC tools unchanged)

**Changed:**
- LLM calls no longer go through IPC → removes batch timeout issue
- Proxy forwards streaming responses directly → lower latency
- Taint budget check for LLM calls is bypassed (was in IPC handler) → TODO: add taint check in proxy if needed

**Risk mitigation:**
- Proxy only forwards to `api.anthropic.com` (hardcoded default)
- Agent can only reach `/v1/messages` endpoint (404 for everything else)
- Body size limited to 4MB
