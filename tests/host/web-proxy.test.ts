import { describe, test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as net from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { startWebProxy, type WebProxy, type ProxyAuditEntry } from '../../src/host/web-proxy.js';

// ── Test helpers ─────────────────────────────────────────────────────

/** Start a simple HTTP server that echoes request info back. */
function startEchoServer(): Promise<{ port: number; server: Server }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body,
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, server });
    });
  });
}

/** Start a TCP echo server (for CONNECT tunnel testing). */
function startTCPEchoServer(): Promise<{ port: number; server: net.Server }> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        socket.write(`echo:${data.toString()}`);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, server });
    });
  });
}

/** Make an HTTP request through a proxy. */
async function proxyFetch(
  proxyPort: number,
  targetUrl: string,
  opts?: { method?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(`http://127.0.0.1:${proxyPort}`);
    const target = new URL(targetUrl);

    const req = require('node:http').request({
      host: proxy.hostname,
      port: proxy.port,
      method: opts?.method ?? 'GET',
      path: targetUrl, // Full URL for proxy request
      headers: {
        Host: target.host,
      },
    }, (res: any) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString(),
        });
      });
    });

    req.on('error', reject);
    if (opts?.body) req.write(opts.body);
    req.end();
  });
}

/** Send a CONNECT request through a proxy and interact with the tunnel. */
async function proxyConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  data: string,
): Promise<{ established: boolean; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });

    let buffer = '';
    let established = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!established && buffer.includes('\r\n\r\n')) {
        established = buffer.startsWith('HTTP/1.1 200');
        if (established) {
          // Tunnel is open — send data
          socket.write(data);
        } else {
          socket.end();
          resolve({ established: false, response: buffer });
        }
      } else if (established && buffer.includes('echo:')) {
        // Got echo response from target
        const echoStart = buffer.indexOf('echo:');
        const response = buffer.slice(echoStart);
        socket.end();
        resolve({ established: true, response });
      }
    });

    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      reject(new Error('Timeout'));
    }, 5000);
  });
}

// ── Tests ────────────────────────────────────────────────────────────

/** Allow localhost connections in tests (proxy blocks private IPs by default). */
const ALLOW_LOCALHOST = new Set(['127.0.0.1']);

describe('web-proxy', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  test('module exports startWebProxy function', async () => {
    const mod = await import('../../src/host/web-proxy.js');
    expect(typeof mod.startWebProxy).toBe('function');
  });

  describe('TCP listener mode', () => {
    test('starts on ephemeral port', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      cleanups.push(proxy.stop);
      expect(typeof proxy.address).toBe('number');
      expect(proxy.address).toBeGreaterThan(0);
    });

    test('HTTP GET forwarding', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/hello?q=1`,
      );

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.method).toBe('GET');
      expect(body.url).toBe('/hello?q=1');
    });

    test('HTTP POST forwarding', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/upload`,
        { method: 'POST', body: '{"key":"value"}' },
      );

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.method).toBe('POST');
      expect(body.body).toBe('{"key":"value"}');
    });
  });

  describe('CONNECT tunneling', () => {
    test('establishes tunnel and forwards bytes', async () => {
      const echo = await startTCPEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      cleanups.push(proxy.stop);

      const result = await proxyConnect(
        proxy.address as number,
        '127.0.0.1',
        echo.port,
        'hello-tunnel',
      );

      expect(result.established).toBe(true);
      expect(result.response).toContain('echo:hello-tunnel');
    });

    test('rejects CONNECT to invalid target', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session' });
      cleanups.push(proxy.stop);

      const result = await proxyConnect(
        proxy.address as number,
        '',
        0,
        'test',
      ).catch((err) => ({ established: false, response: err.message }));

      expect(result.established).toBe(false);
    });
  });

  describe('private IP blocking', () => {
    test('blocks requests to 169.254.169.254 (cloud metadata)', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session' });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        'http://169.254.169.254/latest/meta-data/',
      );

      expect(result.status).toBe(403);
      expect(result.body).toContain('Blocked');
    });

    test('blocks requests to 10.x.x.x', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session' });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        'http://10.0.0.1/',
      );

      expect(result.status).toBe(403);
      expect(result.body).toContain('Blocked');
    });

    test('blocks CONNECT to private IPs', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session' });
      cleanups.push(proxy.stop);

      const result = await proxyConnect(
        proxy.address as number,
        '10.0.0.1',
        443,
        'test',
      ).catch(() => ({ established: false, response: 'blocked' }));

      expect(result.established).toBe(false);
    });
  });

  describe('canary token scanning', () => {
    test('blocks request when canary detected in body', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const canary = 'CANARY-abcdef1234567890abcdef1234567890';
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-session',
        canaryToken: canary,
        allowedIPs: ALLOW_LOCALHOST,
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/exfil`,
        { method: 'POST', body: `data with ${canary} inside` },
      );

      expect(result.status).toBe(403);
      expect(result.body).toContain('canary');
    });

    test('allows request without canary in body', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const canary = 'CANARY-abcdef1234567890abcdef1234567890';
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-session',
        canaryToken: canary,
        allowedIPs: ALLOW_LOCALHOST,
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/safe`,
        { method: 'POST', body: 'normal data' },
      );

      expect(result.status).toBe(200);
    });
  });

  describe('audit logging', () => {
    test('emits audit entries for HTTP requests', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const entries: ProxyAuditEntry[] = [];
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'audit-session',
        onAudit: (e) => entries.push(e),
        allowedIPs: ALLOW_LOCALHOST,
      });
      cleanups.push(proxy.stop);

      await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/test`,
      );

      expect(entries.length).toBe(1);
      expect(entries[0].action).toBe('proxy_request');
      expect(entries[0].sessionId).toBe('audit-session');
      expect(entries[0].method).toBe('GET');
      expect(entries[0].url).toContain('/test');
      expect(entries[0].status).toBe(200);
      expect(entries[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    test('emits audit entries with blocked reason for private IPs', async () => {
      const entries: ProxyAuditEntry[] = [];
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'audit-session',
        onAudit: (e) => entries.push(e),
      });
      cleanups.push(proxy.stop);

      await proxyFetch(
        proxy.address as number,
        'http://10.0.0.1/',
      );

      expect(entries.length).toBe(1);
      expect(entries[0].blocked).toContain('Blocked');
      expect(entries[0].status).toBe(403);
    });

    test('emits audit entries with blocked reason for canary', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const entries: ProxyAuditEntry[] = [];
      const canary = 'CANARY-test123';
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'audit-session',
        canaryToken: canary,
        onAudit: (e) => entries.push(e),
        allowedIPs: ALLOW_LOCALHOST,
      });
      cleanups.push(proxy.stop);

      await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/exfil`,
        { method: 'POST', body: `leak ${canary}` },
      );

      expect(entries.length).toBe(1);
      expect(entries[0].blocked).toBe('canary_detected');
      expect(entries[0].status).toBe(403);
    });
  });

  describe('Unix socket listener mode', () => {
    test('listens on Unix socket path', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-proxy-test-'));
      const socketPath = join(dir, 'web-proxy.sock');

      const proxy = await startWebProxy({ listen: socketPath, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      cleanups.push(proxy.stop);

      expect(proxy.address).toBe(socketPath);
      // Socket should be created
      expect(existsSync(socketPath)).toBe(true);
    });

    test('cleans up socket on stop', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-proxy-test-'));
      const socketPath = join(dir, 'web-proxy.sock');

      const proxy = await startWebProxy({ listen: socketPath, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      proxy.stop();

      expect(existsSync(socketPath)).toBe(false);
    });
  });

  describe('connection cleanup', () => {
    test('stop() closes server without hanging', async () => {
      const proxy = await startWebProxy({ listen: 0, sessionId: 'test-session', allowedIPs: ALLOW_LOCALHOST });
      const proxyPort = proxy.address as number;

      // Stop should not throw or hang
      proxy.stop();

      // Server should be closed — new connections should fail
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refused = await new Promise<boolean>((resolve) => {
        const socket = net.connect(proxyPort, '127.0.0.1');
        socket.on('error', () => resolve(true));
        socket.on('connect', () => { socket.end(); resolve(false); });
        setTimeout(() => resolve(true), 500);
      });
      expect(refused).toBe(true);
    });
  });
});
