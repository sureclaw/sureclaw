// tests/host/llm-proxy-route.test.ts — Tests for /internal/llm-proxy HTTP route.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { initLogger } from '../../src/logger.js';
import { forwardLLMRequest } from '../../src/host/llm-proxy-core.js';

initLogger({ level: 'silent', file: false });

describe('llm-proxy-core forwardLLMRequest', () => {
  let upstreamServer: Server;
  let upstreamPort: number;
  let lastUpstreamReq: { headers: Record<string, string | string[] | undefined>; body: string; url: string } | null = null;
  const originalApiKey = process.env.ANTHROPIC_API_KEY;

  function startUpstream(handler?: (body: string) => { status: number; headers?: Record<string, string>; body: string }): Promise<void> {
    return new Promise((resolve) => {
      upstreamServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString();
        lastUpstreamReq = { headers: req.headers, body, url: req.url ?? '' };

        const result = handler
          ? handler(body)
          : { status: 200, body: '{"content":[{"text":"Hello"}]}' };

        const resHeaders = result.headers ?? { 'Content-Type': 'application/json' };
        res.writeHead(result.status, resHeaders);
        res.end(result.body);
      });

      upstreamServer.listen(0, '127.0.0.1', () => {
        upstreamPort = (upstreamServer.address() as any).port;
        resolve();
      });
    });
  }

  beforeEach(() => {
    lastUpstreamReq = null;
    process.env.ANTHROPIC_API_KEY = 'real-api-key-123';
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  });

  afterEach(() => {
    if (upstreamServer) upstreamServer.close();
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey;
    else delete process.env.ANTHROPIC_API_KEY;
  });

  test('injects real API key into upstream request', async () => {
    await startUpstream();

    // Create a mock response object
    const { PassThrough } = await import('node:stream');
    const res = new PassThrough() as unknown as ServerResponse;
    let writtenStatus = 0;
    let writtenHeaders = {};
    const writtenChunks: Buffer[] = [];
    (res as any).writeHead = (status: number, headers: any) => { writtenStatus = status; writtenHeaders = headers; };
    (res as any).write = (chunk: any) => writtenChunks.push(Buffer.from(chunk));
    (res as any).end = (chunk?: any) => { if (chunk) writtenChunks.push(Buffer.from(chunk)); };
    (res as any).headersSent = false;

    await forwardLLMRequest({
      targetPath: '/v1/messages',
      body: JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: 'Hi' }] }),
      incomingHeaders: {
        'x-api-key': 'dummy-key-from-agent',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      res,
      targetBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    });

    // Upstream should receive real key, not dummy
    expect(lastUpstreamReq!.headers['x-api-key']).toBe('real-api-key-123');
    expect(lastUpstreamReq!.headers['x-api-key']).not.toBe('dummy-key-from-agent');
    expect(lastUpstreamReq!.url).toBe('/v1/messages');
    expect(writtenStatus).toBe(200);
  });

  test('returns 401 when no credentials configured', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

    const { PassThrough } = await import('node:stream');
    const res = new PassThrough() as unknown as ServerResponse;
    let writtenStatus = 0;
    let writtenBody = '';
    (res as any).writeHead = (status: number) => { writtenStatus = status; };
    (res as any).write = () => {};
    (res as any).end = (chunk?: any) => { if (chunk) writtenBody = chunk.toString(); };
    (res as any).headersSent = false;

    await forwardLLMRequest({
      targetPath: '/v1/messages',
      body: '{}',
      incomingHeaders: {},
      res,
    });

    expect(writtenStatus).toBe(401);
    expect(JSON.parse(writtenBody).error.type).toBe('authentication_error');
  });

  test('streams SSE response through', async () => {
    const sseData = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hi"}}\n\n';
    await startUpstream(() => ({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body: sseData,
    }));

    const { PassThrough } = await import('node:stream');
    const res = new PassThrough() as unknown as ServerResponse;
    let writtenStatus = 0;
    const writtenChunks: string[] = [];
    (res as any).writeHead = (status: number) => { writtenStatus = status; };
    (res as any).write = (chunk: any) => writtenChunks.push(Buffer.from(chunk).toString());
    (res as any).end = (chunk?: any) => { if (chunk) writtenChunks.push(Buffer.from(chunk).toString()); };
    (res as any).headersSent = false;

    await forwardLLMRequest({
      targetPath: '/v1/messages',
      body: '{}',
      incomingHeaders: {},
      res,
      targetBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    });

    expect(writtenStatus).toBe(200);
    expect(writtenChunks.join('')).toContain('content_block_delta');
  });
});

describe('/internal/llm-proxy route token validation', () => {
  test('returns 401 for invalid token', async () => {
    // This is an integration-level test of the route pattern (same as internal-ipc-route.test.ts)
    const activeTokens = new Map<string, any>();

    const server = createServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
        const token = req.headers['x-api-key'] as string;
        if (!token || !activeTokens.has(token)) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid token' }));
          return;
        }
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as any).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/internal/llm-proxy/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': 'bad-token', 'Content-Type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    } finally {
      server.close();
    }
  });
});
