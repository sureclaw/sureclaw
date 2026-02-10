import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startAnthropicProxy } from '../../../src/anthropic-proxy.js';

/**
 * Create a mock Anthropic API server that returns canned responses.
 * The proxy now forwards HTTP to the real API, so tests use this instead of IPC.
 */
function createMockAnthropicApi(
  port: number,
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
): Promise<HttpServer> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      handler(req, Buffer.concat(chunks).toString(), res);
    });
    server.listen(port, () => resolve(server));
  });
}

/**
 * Create a minimal mock IPC server for non-LLM tools (memory, web, etc.).
 * runClaudeCode still uses IPC for these tools even though LLM calls go through the proxy.
 */
function createMockIPCServer(socketPath: string): NetServer {
  const server = createNetServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;
        buffer = buffer.subarray(4 + msgLen);
        // Return { ok: true } for any IPC call
        const responseBuf = Buffer.from(JSON.stringify({ ok: true }), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

function anthropicJsonResponse(content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>, opts?: { stop_reason?: string }) {
  return JSON.stringify({
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-5-20250929',
    stop_reason: opts?.stop_reason ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

describe('claude-code agent', () => {
  let tmpDir: string;
  let mockApi: HttpServer;
  let ipcServer: NetServer;
  let proxyResult: { server: HttpServer; stop: () => void };
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let nextPort = 19910;

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    proxyResult?.stop();
    mockApi?.close();
    ipcServer?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
  });

  test('createSocketFetch works with ESM dynamic import (no require)', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const port = nextPort++;

    // Mock Anthropic API
    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJsonResponse([{ type: 'text', text: 'ESM works!' }]));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Import and test createSocketFetch — if require() was used, this would throw
    // ReferenceError: require is not defined
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    // Verify the custom fetch can reach the proxy at the correct path
    const response = await socketFetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe('message');
  });

  test('Anthropic SDK sends to correct path through unix socket proxy', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const port = nextPort++;

    // Track what the mock API receives
    let receivedUrl: string | undefined;
    mockApi = await createMockAnthropicApi(port, (req, _body, res) => {
      receivedUrl = req.url;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJsonResponse([{ type: 'text', text: 'SDK path test' }]));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Use the Anthropic SDK with baseURL pointing to the proxy — same as claude-code.ts
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const socketFetch = ((input: string | URL | Request, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as RequestInit)) as typeof globalThis.fetch;

    const anthropic = new Anthropic({
      apiKey: 'ax-proxy',
      // Must NOT include /v1 — the SDK adds /v1 itself
      baseURL: 'http://localhost',
      fetch: socketFetch,
    });

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Verify the SDK got a valid response (not 404)
    expect(response.content).toHaveLength(1);
    expect(response.content[0].type).toBe('text');
    expect((response.content[0] as { type: 'text'; text: string }).text).toBe('SDK path test');

    // Verify the mock API received the request at the correct path
    expect(receivedUrl).toBe('/v1/messages');
  });

  test('runClaudeCode completes a full message cycle', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const workspaceDir = join(tmpDir, 'workspace');
    const skillsDir = join(tmpDir, 'skills');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const port = nextPort++;

    // Mock IPC server for non-LLM tools (memory, web, etc.)
    ipcServer = createMockIPCServer(ipcSocketPath);
    await new Promise<void>((r) => ipcServer.on('listening', r));

    // Mock Anthropic API — responds with text (no tools)
    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(anthropicJsonResponse([{ type: 'text', text: 'Hello from claude-code!' }]));
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Capture stdout
    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;

    // Suppress stderr (debug logging)
    process.stderr.write = (() => true) as typeof process.stderr.write;

    // Run the agent
    const { runClaudeCode } = await import('../../../src/container/agents/claude-code.js');
    await runClaudeCode({
      agent: 'claude-code',
      ipcSocket: ipcSocketPath,
      proxySocket: proxySocketPath,
      workspace: workspaceDir,
      skills: skillsDir,
      userMessage: 'Say hello',
    });

    expect(stdout).toContain('Hello from claude-code!');
  });

  test('runClaudeCode executes tools and sends results back', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cc-test-'));
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const workspaceDir = join(tmpDir, 'workspace');
    const skillsDir = join(tmpDir, 'skills');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(skillsDir, { recursive: true });
    const port = nextPort++;

    // Mock IPC server for non-LLM tools (memory, web, etc.)
    ipcServer = createMockIPCServer(ipcSocketPath);
    await new Promise<void>((r) => ipcServer.on('listening', r));

    // Create a file for the agent to read
    writeFileSync(join(workspaceDir, 'test.txt'), 'file content here');

    // Mock Anthropic API: first call returns tool_use, second returns text
    let callCount = 0;
    mockApi = await createMockAnthropicApi(port, (_req, _body, res) => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (callCount === 1) {
        // First LLM call: ask to read a file
        res.end(anthropicJsonResponse(
          [{ type: 'tool_use', id: 'tc_1', name: 'read_file', input: { path: 'test.txt' } }],
          { stop_reason: 'tool_use' },
        ));
      } else {
        // Second LLM call: produce final text
        res.end(anthropicJsonResponse([{ type: 'text', text: 'The file says: file content here' }]));
      }
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    let stdout = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;

    const { runClaudeCode } = await import('../../../src/container/agents/claude-code.js');
    await runClaudeCode({
      agent: 'claude-code',
      ipcSocket: ipcSocketPath,
      proxySocket: proxySocketPath,
      workspace: workspaceDir,
      skills: skillsDir,
      userMessage: 'Read test.txt',
    });

    // Agent should have made 2 LLM calls (tool_use + final text)
    expect(callCount).toBe(2);
    expect(stdout).toContain('The file says: file content here');
  });
});
