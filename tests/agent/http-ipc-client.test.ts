// tests/agent/http-ipc-client.test.ts — Tests for HTTP-based IPC client.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { initLogger } from '../../src/logger.js';
import { HttpIPCClient } from '../../src/agent/http-ipc-client.js';

initLogger({ level: 'silent', file: false });

describe('HttpIPCClient', () => {
  let server: Server;
  let port: number;
  let lastRequest: { headers: Record<string, string | undefined>; body: any } | null = null;

  function startServer(handler: (body: any) => any, delay = 0): Promise<void> {
    return new Promise((resolve) => {
      server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        lastRequest = {
          headers: {
            authorization: req.headers.authorization,
            'content-type': req.headers['content-type'],
          },
          body,
        };

        if (delay > 0) await new Promise(r => setTimeout(r, delay));

        const response = handler(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(response));
      });
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  }

  beforeEach(() => {
    lastRequest = null;
    delete process.env.AX_IPC_TOKEN;
  });

  afterEach(() => {
    if (server) server.close();
    delete process.env.AX_IPC_TOKEN;
  });

  test('sends IPC call as POST to /internal/ipc', async () => {
    await startServer(() => ({ result: 'ok' }));

    const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${port}` });
    client.setContext({ token: 'test-token', sessionId: 'sess-1' });
    const result = await client.call({ action: 'memory_read', key: 'foo' });

    expect(result).toEqual({ result: 'ok' });
    expect(lastRequest!.headers.authorization).toBe('Bearer test-token');
    expect(lastRequest!.headers['content-type']).toBe('application/json');
    expect(lastRequest!.body._sessionId).toBe('sess-1');
    expect(lastRequest!.body.action).toBe('memory_read');
  });

  test('enriches request with session metadata', async () => {
    await startServer(() => ({ ok: true }));

    const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${port}` });
    client.setContext({ sessionId: 's1', requestId: 'r1', userId: 'u1', sessionScope: 'dm', token: 't1' });
    await client.call({ action: 'web_fetch', url: 'https://example.com' });

    expect(lastRequest!.body._sessionId).toBe('s1');
    expect(lastRequest!.body._requestId).toBe('r1');
    expect(lastRequest!.body._userId).toBe('u1');
    expect(lastRequest!.body._sessionScope).toBe('dm');
  });

  test('throws on timeout', async () => {
    await startServer(() => ({ ok: true }), 500);

    const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${port}`, timeoutMs: 50 });
    client.setContext({ token: 'tok' });
    await expect(client.call({ action: 'llm_call' })).rejects.toThrow();
  });

  test('connect() and disconnect() are no-ops', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://127.0.0.1:1' });
    await client.connect(); // no-op, no throw
    client.disconnect();    // no-op, no throw
  });

  test('reads token from AX_IPC_TOKEN env if not set via setContext', async () => {
    process.env.AX_IPC_TOKEN = 'env-token-123';
    await startServer(() => ({ ok: true }));

    const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${port}` });
    await client.call({ action: 'test' });

    expect(lastRequest!.headers.authorization).toBe('Bearer env-token-123');
  });
});
