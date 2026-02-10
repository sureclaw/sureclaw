import { describe, test, expect, afterEach, beforeEach } from 'vitest';
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

  // Each test gets its own port to avoid EADDRINUSE
  let nextPort = 19901;

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

  function startMockApi(
    handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
  ): Promise<number> {
    const port = nextPort++;
    return new Promise((resolve) => {
      mockApi = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        handler(req, Buffer.concat(chunks).toString(), res);
      });
      mockApi.listen(port, () => resolve(port));
    });
  }

  test('injects x-api-key when ANTHROPIC_API_KEY is set', async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    const port = await startMockApi((req, _body, res) => {
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
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
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
    const port = await startMockApi((req, _body, res) => {
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
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
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
    const port = await startMockApi((_req, _body, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });

    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const proxySocketPath = join(tmpDir, 'proxy.sock');
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
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
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${nextPort++}`);
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
    const port = await startMockApi((req, _body, res) => {
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
    proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
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

    // API key should win
    expect(receivedHeaders['x-api-key']).toBe('sk-ant-real');
    // Authorization header should be removed
    expect(receivedHeaders['authorization']).toBeUndefined();
  });
});
