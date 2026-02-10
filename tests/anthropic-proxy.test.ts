import { describe, test, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { startAnthropicProxy } from '../src/anthropic-proxy.js';

/**
 * Create a minimal mock IPC server that responds to llm_call with a canned response.
 */
function createMockIPCServer(
  socketPath: string,
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Server {
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 4) {
        const msgLen = buffer.readUInt32BE(0);
        if (buffer.length < 4 + msgLen) break;
        const raw = buffer.subarray(4, 4 + msgLen).toString('utf-8');
        buffer = buffer.subarray(4 + msgLen);
        const request = JSON.parse(raw);
        const response = handler(request);
        const responseBuf = Buffer.from(JSON.stringify(response), 'utf-8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32BE(responseBuf.length, 0);
        socket.write(Buffer.concat([lenBuf, responseBuf]));
      }
    });
  });
  server.listen(socketPath);
  return server;
}

describe('Anthropic API Proxy', () => {
  let tmpDir: string;
  let ipcServer: Server;
  let proxyResult: { server: import('node:http').Server; stop: () => void };

  afterEach(() => {
    proxyResult?.stop();
    ipcServer?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('translates POST /v1/messages to IPC llm_call and returns Anthropic JSON', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const proxySocketPath = join(tmpDir, 'proxy.sock');

    // Set up mock IPC server
    let receivedRequest: Record<string, unknown> | null = null;
    ipcServer = createMockIPCServer(ipcSocketPath, (req) => {
      receivedRequest = req;
      return {
        ok: true,
        chunks: [
          { type: 'text', content: 'Hello from proxy!' },
          { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      };
    });
    await new Promise<void>((r) => ipcServer.on('listening', r));

    // Start proxy
    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    // Make HTTP request to proxy
    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        system: 'You are helpful.',
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    // Verify response is in Anthropic format
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('claude-sonnet-4-5-20250929');
    expect(body.stop_reason).toBe('end_turn');

    const content = body.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('Hello from proxy!');

    // Verify IPC call was made correctly
    expect(receivedRequest).not.toBeNull();
    expect(receivedRequest!.action).toBe('llm_call');
    expect(receivedRequest!.model).toBe('claude-sonnet-4-5-20250929');
  });

  test('returns 404 for non-messages endpoints', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const proxySocketPath = join(tmpDir, 'proxy.sock');

    ipcServer = createMockIPCServer(ipcSocketPath, () => ({ ok: true }));
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/models', {
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(404);
  });

  test('handles streaming SSE responses', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const proxySocketPath = join(tmpDir, 'proxy.sock');

    ipcServer = createMockIPCServer(ipcSocketPath, () => ({
      ok: true,
      chunks: [
        { type: 'text', content: 'Streamed!' },
        { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } },
      ],
    }));
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const text = await response.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('Streamed!');
    expect(text).toContain('event: message_stop');
  });

  test('returns error when IPC call fails', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const proxySocketPath = join(tmpDir, 'proxy.sock');

    ipcServer = createMockIPCServer(ipcSocketPath, () => ({
      ok: false,
      error: 'LLM provider error',
    }));
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(500);
    const body = await response.json() as Record<string, unknown>;
    expect(body.type).toBe('error');
  });

  test('passes tool definitions through to IPC', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
    const ipcSocketPath = join(tmpDir, 'ipc.sock');
    const proxySocketPath = join(tmpDir, 'proxy.sock');

    let receivedTools: unknown[] = [];
    ipcServer = createMockIPCServer(ipcSocketPath, (req) => {
      receivedTools = (req.tools as unknown[]) ?? [];
      return {
        ok: true,
        chunks: [
          { type: 'tool_use', toolCall: { id: 'tc1', name: 'read_file', args: { path: 'test.txt' } } },
          { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } },
        ],
      };
    });
    await new Promise<void>((r) => ipcServer.on('listening', r));

    proxyResult = startAnthropicProxy(proxySocketPath, ipcSocketPath);
    await new Promise<void>((r) => proxyResult.server.on('listening', r));

    const { Agent } = await import('undici');
    const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
    const response = await fetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'Read test.txt' }],
        tools: [{
          name: 'read_file',
          description: 'Read a file',
          input_schema: { type: 'object', properties: { path: { type: 'string' } } },
        }],
      }),
      dispatcher,
    } as RequestInit);

    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;

    // Verify tool_use block in response
    expect(body.stop_reason).toBe('tool_use');
    const content = body.content as Array<Record<string, unknown>>;
    const toolBlock = content.find(b => b.type === 'tool_use');
    expect(toolBlock).toBeTruthy();
    expect(toolBlock!.name).toBe('read_file');

    // Verify tools were forwarded to IPC
    expect(receivedTools).toHaveLength(1);
    expect((receivedTools[0] as Record<string, unknown>).name).toBe('read_file');
  });
});
