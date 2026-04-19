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

  test('retries once when the initial fetch fails with UND_ERR_SOCKET "other side closed"', async () => {
    // Regression: sandbox <-> host uses Node fetch() with undici's connection
    // pool under the hood. A stale keep-alive connection — one the server
    // closed while it sat idle in the pool — throws UND_ERR_SOCKET immediately
    // (~1ms duration) on the next request that tries to reuse it. The failing
    // call carries no bytes to the server, so one transparent retry is safe
    // (the second request opens a fresh connection) and turns a flaky dev-loop
    // hiccup into a non-event.
    await startServer(() => ({ result: 'ok-after-retry' }));

    const { vi } = await import('vitest');
    const realFetch = globalThis.fetch;
    let calls = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      calls++;
      if (calls === 1) {
        // Shape the error like undici's: outer "fetch failed" with a .cause
        // carrying the real code. Same as what the user's log showed.
        const cause: Error & { code?: string } = new Error('other side closed');
        cause.code = 'UND_ERR_SOCKET';
        throw Object.assign(new Error('fetch failed'), { cause });
      }
      return realFetch(...(args as Parameters<typeof fetch>));
    });

    try {
      const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${port}` });
      client.setContext({ token: 't', sessionId: 's' });
      const result = await client.call({ action: 'memory_read', key: 'k' });
      expect(result).toEqual({ result: 'ok-after-retry' });
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('does NOT retry on non-socket errors (e.g., ECONNREFUSED) — surfaces the original failure', async () => {
    // Only stale-keepalive looks safe to auto-retry. Other errors (server
    // actually down, DNS failure, auth failure) should bubble up without
    // the extra round-trip so the caller sees the real problem.
    const { vi } = await import('vitest');
    let calls = 0;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls++;
      const cause: Error & { code?: string } = new Error('connect ECONNREFUSED 127.0.0.1:1');
      cause.code = 'ECONNREFUSED';
      throw Object.assign(new Error('fetch failed'), { cause });
    });

    try {
      const client = new HttpIPCClient({ hostUrl: 'http://127.0.0.1:1' });
      client.setContext({ token: 't', sessionId: 's' });
      await expect(
        client.call({ action: 'memory_read', key: 'k' }),
      ).rejects.toThrow(/ECONNREFUSED/);
      expect(calls).toBe(1);
    } finally {
      spy.mockRestore();
    }
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

  test('fetchWork uses original auth token even after setContext rotates the IPC token', async () => {
    // Regression: fetchWork must use the pod's original auth token (from AX_IPC_TOKEN env)
    // for work-fetch authentication, not the per-turn IPC token set by applyPayload/setContext.
    // When setContext updates this.token for IPC routing, fetchWork should still authenticate
    // with the original token that the session-pod-manager recognizes.
    process.env.AX_IPC_TOKEN = 'spawn-token-1';

    const workTokens: string[] = [];
    const workServer = createServer((req, res) => {
      workTokens.push(req.headers.authorization ?? '');
      // Return 404 (no work) — fetchWork will exit after maxWaitMs
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no work' }));
    });
    await new Promise<void>(resolve => {
      workServer.listen(0, '127.0.0.1', resolve);
    });
    const workPort = (workServer.address() as any).port;

    try {
      const client = new HttpIPCClient({ hostUrl: `http://127.0.0.1:${workPort}` });

      // Simulate what applyPayload does: rotate the IPC token to a per-turn token
      client.setContext({ token: 'turn-token-2' });

      // fetchWork should still use the original spawn-token-1, not turn-token-2
      await client.fetchWork(50, 100);

      expect(workTokens.length).toBeGreaterThan(0);
      for (const tok of workTokens) {
        expect(tok).toBe('Bearer spawn-token-1');
      }
    } finally {
      workServer.close();
    }
  });
});
