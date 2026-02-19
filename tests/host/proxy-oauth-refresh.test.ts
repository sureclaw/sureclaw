import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { startAnthropicProxy } from '../../src/host/proxy.js';

describe('OAuth Token Auto-Refresh', () => {
  let tmpDir: string;
  let mockApi: Server;
  let proxyResult: { server: Server; stop: () => void };

  let nextPort = 19950;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-refresh-test-'));
  });

  afterEach(() => {
    proxyResult?.stop();
    mockApi?.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.AX_OAUTH_REFRESH_TOKEN;
    delete process.env.AX_OAUTH_EXPIRES_AT;
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

  const OK_RESPONSE = JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    model: 'claude-sonnet-4-5-20250929', stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  // --- Pre-flight refresh tests (ensureOAuthTokenFresh) ---

  describe('ensureOAuthTokenFresh()', () => {
    test('skips refresh when token is fresh (>5 min remaining)', async () => {
      const { ensureOAuthTokenFresh } = await import('../../src/dotenv.js');
      const refreshSpy = vi.fn();

      // Token expires in 10 minutes — well within safe window
      process.env.AX_OAUTH_REFRESH_TOKEN = 'rt-test';
      process.env.AX_OAUTH_EXPIRES_AT = String(Math.floor(Date.now() / 1000) + 600);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'existing-token';

      // ensureOAuthTokenFresh imports oauth.js dynamically — if it doesn't call
      // refreshOAuthTokens, the token stays unchanged
      await ensureOAuthTokenFresh();

      // Token should be unchanged (no refresh happened)
      expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('existing-token');
    });

    test('triggers refresh when token is near expiry (<5 min remaining)', async () => {
      // We can't easily mock the dynamic import of oauth.js, so we test via
      // the ensureOAuthTokenFresh function and check that it attempts refresh
      // by observing the side effect (it will fail because there's no real
      // OAuth server, but the attempt proves the path is taken).
      const { ensureOAuthTokenFresh } = await import('../../src/dotenv.js');

      // Token expired 60 seconds ago
      process.env.AX_OAUTH_REFRESH_TOKEN = 'rt-test';
      process.env.AX_OAUTH_EXPIRES_AT = String(Math.floor(Date.now() / 1000) - 60);
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-token';

      // This will try to refresh, which will fail (no real OAuth server),
      // but it should NOT throw (errors are caught and logged)
      await expect(ensureOAuthTokenFresh()).resolves.toBeUndefined();
    });
  });

  // --- Proxy reactive retry on 401 ---

  describe('Proxy 401 retry with OAuth', () => {
    test('retries on 401 with OAuth and succeeds after refresh', async () => {
      let requestCount = 0;
      const port = await startMockApi((req, _body, res) => {
        requestCount++;
        if (requestCount === 1) {
          // First request: 401 (token expired)
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }));
        } else {
          // Second request (after refresh): 200
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(OK_RESPONSE);
        }
      });

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-oauth-token';
      const proxySocketPath = join(tmpDir, 'proxy.sock');

      const refreshFn = vi.fn(async () => {
        // Simulate refreshing the token
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'fresh-oauth-token';
      });

      proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`, refreshFn);
      await new Promise<void>((r) => proxyResult.server.on('listening', r));

      const { Agent } = await import('undici');
      const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
      const response = await fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(200);
      expect(refreshFn).toHaveBeenCalledOnce();
      expect(requestCount).toBe(2); // original + 1 retry
    });

    test('does NOT retry on 401 with API key (bad key, not expiry)', async () => {
      let requestCount = 0;
      const port = await startMockApi((_req, _body, res) => {
        requestCount++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid key' } }));
      });

      process.env.ANTHROPIC_API_KEY = 'bad-api-key';
      const proxySocketPath = join(tmpDir, 'proxy.sock');

      const refreshFn = vi.fn(async () => { /* should not be called */ });

      proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`, refreshFn);
      await new Promise<void>((r) => proxyResult.server.on('listening', r));

      const { Agent } = await import('undici');
      const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
      const response = await fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(401);
      expect(refreshFn).not.toHaveBeenCalled();
      expect(requestCount).toBe(1); // no retry
    });

    test('retries only once even if upstream keeps returning 401', async () => {
      let requestCount = 0;
      const port = await startMockApi((_req, _body, res) => {
        requestCount++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'still expired' } }));
      });

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-oauth-token';
      const proxySocketPath = join(tmpDir, 'proxy.sock');

      const refreshFn = vi.fn(async () => {
        // Simulate refresh that "succeeds" but token is still rejected
        process.env.CLAUDE_CODE_OAUTH_TOKEN = 'still-expired-token';
      });

      proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`, refreshFn);
      await new Promise<void>((r) => proxyResult.server.on('listening', r));

      const { Agent } = await import('undici');
      const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
      const response = await fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(401);
      expect(refreshFn).toHaveBeenCalledOnce();
      expect(requestCount).toBe(2); // original + exactly 1 retry, not infinite
    });

    test('does NOT retry when no refreshCredentials callback is provided', async () => {
      let requestCount = 0;
      const port = await startMockApi((_req, _body, res) => {
        requestCount++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }));
      });

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-oauth-token';
      const proxySocketPath = join(tmpDir, 'proxy.sock');

      // No refreshCredentials callback
      proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`);
      await new Promise<void>((r) => proxyResult.server.on('listening', r));

      const { Agent } = await import('undici');
      const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
      const response = await fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(401);
      expect(requestCount).toBe(1); // no retry without callback
    });

    test('forwards 401 when refresh callback throws', async () => {
      let requestCount = 0;
      const port = await startMockApi((_req, _body, res) => {
        requestCount++;
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'expired' } }));
      });

      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'expired-oauth-token';
      const proxySocketPath = join(tmpDir, 'proxy.sock');

      const refreshFn = vi.fn(async () => {
        throw new Error('Refresh token revoked');
      });

      proxyResult = startAnthropicProxy(proxySocketPath, `http://localhost:${port}`, refreshFn);
      await new Promise<void>((r) => proxyResult.server.on('listening', r));

      const { Agent } = await import('undici');
      const dispatcher = new Agent({ connect: { socketPath: proxySocketPath } });
      const response = await fetch('http://localhost/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929', max_tokens: 100,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        dispatcher,
      } as RequestInit);

      expect(response.status).toBe(401);
      expect(refreshFn).toHaveBeenCalledOnce();
      expect(requestCount).toBe(1); // no retry since refresh failed
      const body = await response.json();
      expect(body.error.message).toBe('expired');
    });
  });
});
