import { describe, test, expect, beforeEach } from 'vitest';
import { create } from '../../src/providers/web/fetch.js';
import type { WebProvider, Config } from '../../src/providers/types.js';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

// ── Test HTTP server ──

let server: Server;
let baseUrl: string;

function startServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): Promise<void> {
  return new Promise((resolve) => {
    if (server) server.close(() => resolve());
    else resolve();
  });
}

const config = { profile: 'standard' } as Config;

// Provider with 127.0.0.1 allowed (for local test server)
const testOpts = { allowedIPs: new Set(['127.0.0.1']) };

describe('web-fetch provider', () => {
  // ── Tests that hit a local server (allowedIPs bypasses SSRF check) ──

  describe('basic fetch', () => {
    let web: WebProvider;

    beforeEach(async () => {
      web = await create(config, testOpts);
    });

    test('fetches a URL and returns body with taint tag', async () => {
      await startServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('hello world');
      });
      try {
        const resp = await web.fetch({ url: baseUrl });
        expect(resp.status).toBe(200);
        expect(resp.body).toBe('hello world');
        expect(resp.taint.source).toBe('web_fetch');
        expect(resp.taint.trust).toBe('external');
        expect(resp.taint.timestamp).toBeInstanceOf(Date);
        expect(resp.headers['content-type']).toBe('text/plain');
      } finally {
        await stopServer();
      }
    });

    test('sends custom headers', async () => {
      let receivedHeaders: Record<string, string | string[] | undefined> = {};
      await startServer((req, res) => {
        receivedHeaders = req.headers;
        res.writeHead(200);
        res.end('ok');
      });
      try {
        await web.fetch({
          url: baseUrl,
          headers: { 'X-Custom': 'test-value' },
        });
        expect(receivedHeaders['x-custom']).toBe('test-value');
      } finally {
        await stopServer();
      }
    });

    test('supports HEAD method', async () => {
      let method = '';
      await startServer((req, res) => {
        method = req.method ?? '';
        res.writeHead(200, { 'X-Info': 'head-response' });
        res.end();
      });
      try {
        const resp = await web.fetch({ url: baseUrl, method: 'HEAD' });
        expect(method).toBe('HEAD');
        expect(resp.status).toBe(200);
        expect(resp.body).toBe('');
      } finally {
        await stopServer();
      }
    });

    test('enforces timeout', async () => {
      await startServer((_req, _res) => {
        // Never respond — let it hang
      });
      try {
        await expect(
          web.fetch({ url: baseUrl, timeoutMs: 200 })
        ).rejects.toThrow(/timeout/i);
      } finally {
        await stopServer();
      }
    });

    test('truncates response body exceeding size limit', async () => {
      const bigBody = 'x'.repeat(2 * 1024 * 1024); // 2MB
      await startServer((_req, res) => {
        res.writeHead(200);
        res.end(bigBody);
      });
      try {
        const resp = await web.fetch({ url: baseUrl });
        // Default max should be 1MB
        expect(resp.body.length).toBeLessThanOrEqual(1024 * 1024);
      } finally {
        await stopServer();
      }
    });

    test('returns error status codes without throwing', async () => {
      await startServer((_req, res) => {
        res.writeHead(404);
        res.end('not found');
      });
      try {
        const resp = await web.fetch({ url: baseUrl });
        expect(resp.status).toBe(404);
        expect(resp.body).toBe('not found');
        expect(resp.taint.trust).toBe('external');
      } finally {
        await stopServer();
      }
    });
  });

  // ── SSRF protection (default provider, no allowedIPs) ──

  describe('SSRF protection', () => {
    let web: WebProvider;

    beforeEach(async () => {
      web = await create(config);
    });

    test('blocks requests to localhost 127.x.x.x', async () => {
      await expect(
        web.fetch({ url: 'http://127.0.0.1:9999/secret' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to 169.254.169.254 (cloud metadata)', async () => {
      await expect(
        web.fetch({ url: 'http://169.254.169.254/latest/meta-data/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to 10.x.x.x private range', async () => {
      await expect(
        web.fetch({ url: 'http://10.0.0.1/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to 192.168.x.x private range', async () => {
      await expect(
        web.fetch({ url: 'http://192.168.1.1/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to 172.16-31.x.x private range', async () => {
      await expect(
        web.fetch({ url: 'http://172.16.0.1/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to [::1] IPv6 loopback', async () => {
      await expect(
        web.fetch({ url: 'http://[::1]:9999/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('blocks requests to 0.0.0.0', async () => {
      await expect(
        web.fetch({ url: 'http://0.0.0.0/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });

    test('resolves DNS and pins IP before connecting', async () => {
      // localhost resolves to 127.0.0.1 which is private — should be blocked
      await expect(
        web.fetch({ url: 'http://localhost:9999/' })
      ).rejects.toThrow(/blocked|private|denied/i);
    });
  });

  // ── Protocol restrictions ──

  describe('protocol restrictions', () => {
    let web: WebProvider;

    beforeEach(async () => {
      web = await create(config);
    });

    test('rejects non-HTTP(S) protocols', async () => {
      await expect(
        web.fetch({ url: 'file:///etc/passwd' })
      ).rejects.toThrow(/protocol|unsupported/i);
    });

    test('rejects FTP protocol', async () => {
      await expect(
        web.fetch({ url: 'ftp://example.com/file' })
      ).rejects.toThrow(/protocol|unsupported/i);
    });
  });

  // ── search stub ──

  test('search throws not implemented', async () => {
    const web = await create(config);
    await expect(
      web.search('test query')
    ).rejects.toThrow(/not implemented|not available/i);
  });
});
