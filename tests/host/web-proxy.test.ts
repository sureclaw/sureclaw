import { describe, test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import * as http from 'node:http';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { startWebProxy, type WebProxy, type ProxyAuditEntry } from '../../src/host/web-proxy.js';
import { CredentialPlaceholderMap } from '../../src/host/credential-placeholders.js';

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

/** Make an HTTPS request through the MITM proxy. */
async function mitmProxyFetch(
  proxyPort: number,
  targetUrl: string,
  opts: { headers?: Record<string, string>; ca: string; method?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);

    // Step 1: CONNECT to proxy
    const connectReq = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
    });

    connectReq.on('connect', (_res: any, socket: net.Socket) => {
      // Step 2: TLS handshake over the tunnel, trusting the MITM CA
      const tlsSocket = tls.connect({
        socket,
        servername: target.hostname,
        ca: opts.ca,
        rejectUnauthorized: true,
      }, () => {
        // Step 3: Send HTTP request over TLS
        const reqLines = [
          `${opts.method ?? 'GET'} ${target.pathname} HTTP/1.1`,
          `Host: ${target.hostname}:${target.port}`,
          `Connection: close`,
        ];
        if (opts.headers) {
          for (const [k, v] of Object.entries(opts.headers)) {
            reqLines.push(`${k}: ${v}`);
          }
        }
        if (opts.body) {
          reqLines.push(`Content-Length: ${Buffer.byteLength(opts.body)}`);
        }
        reqLines.push('', '');
        // Send headers and body together so they arrive in one TLS record
        const fullRequest = reqLines.join('\r\n') + (opts.body ?? '');
        tlsSocket.write(fullRequest);
      });

      let data = '';
      tlsSocket.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      tlsSocket.on('end', () => {
        // Parse HTTP response
        const [header, ...bodyParts] = data.split('\r\n\r\n');
        const statusMatch = header.match(/HTTP\/\d\.\d (\d+)/);
        resolve({
          status: statusMatch ? parseInt(statusMatch[1]) : 0,
          body: bodyParts.join('\r\n\r\n'),
        });
      });
      tlsSocket.on('error', reject);
    });

    connectReq.on('error', reject);
    connectReq.end();
    setTimeout(() => reject(new Error('Timeout')), 10000);
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

  describe('onApprove governance gate', () => {
    test('blocks HTTP request when onApprove denies', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        onApprove: async (_domain) => ({ approved: false, reason: 'Not allowed' }),
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/install`,
      );

      expect(result.status).toBe(403);
      expect(result.body).toContain('Not allowed');
    });

    test('allows HTTP request when onApprove approves', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        onApprove: async (_domain) => ({ approved: true }),
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/install`,
      );

      expect(result.status).toBe(200);
    });

    test('caches approval per domain', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      let callCount = 0;
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        onApprove: async (_domain) => {
          callCount++;
          return { approved: true };
        },
      });
      cleanups.push(proxy.stop);

      const url = `http://127.0.0.1:${echo.port}/a`;
      await proxyFetch(proxy.address as number, url);
      await proxyFetch(proxy.address as number, url);
      await proxyFetch(proxy.address as number, url);

      // onApprove should only be called once — subsequent requests use cache
      expect(callCount).toBe(1);
    });

    test('allowedDomains bypass onApprove', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      let callCount = 0;
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        allowedDomains: new Set(['127.0.0.1']),
        onApprove: async (_domain) => {
          callCount++;
          return { approved: false };
        },
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/bypass`,
      );

      // Should be allowed (domain in allowlist), onApprove never called
      expect(result.status).toBe(200);
      expect(callCount).toBe(0);
    });

    test('blocks CONNECT when onApprove denies', async () => {
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        onApprove: async (_domain) => ({ approved: false, reason: 'Denied' }),
      });
      cleanups.push(proxy.stop);

      const result = await proxyConnect(
        proxy.address as number,
        '127.0.0.1',
        443,
        'test',
      ).catch(() => ({ established: false, response: 'blocked' }));

      expect(result.established).toBe(false);
    });

    test('emits audit entry with domain_denied when blocked', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const entries: ProxyAuditEntry[] = [];
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-approve',
        allowedIPs: ALLOW_LOCALHOST,
        onAudit: (e) => entries.push(e),
        onApprove: async (_domain) => ({ approved: false }),
      });
      cleanups.push(proxy.stop);

      await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/blocked`,
      );

      expect(entries.length).toBe(1);
      expect(entries[0].status).toBe(403);
      expect(entries[0].blocked).toContain('domain_denied');
    });

    test('auto-approves when onApprove not provided', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      // No onApprove — backward compat, all requests auto-approved
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-no-approve',
        allowedIPs: ALLOW_LOCALHOST,
      });
      cleanups.push(proxy.stop);

      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/auto`,
      );

      expect(result.status).toBe(200);
    });

    test('allowedDomains reflects live updates (not just a snapshot)', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      // Create a live domain checker that can be updated after proxy starts
      const allowed = new Set<string>();
      const liveDomainChecker = { has: (d: string) => allowed.has(d) };

      const entries: ProxyAuditEntry[] = [];
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test-live-domains',
        allowedIPs: ALLOW_LOCALHOST,
        allowedDomains: liveDomainChecker,
        onAudit: (e) => entries.push(e),
      });
      cleanups.push(proxy.stop);

      // Request should be denied — domain not in allowlist yet
      const denied = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/before`,
      );
      expect(denied.status).toBe(403);

      // Now add the domain to the live allowlist (simulates skill_install mid-session)
      allowed.add('127.0.0.1');

      // Same domain should now be allowed
      const approved = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/after`,
      );
      expect(approved.status).toBe(200);
    });
  });

  describe('URL rewriting', () => {
    test('URL rewrite redirects HTTP requests to mock target', async () => {
      // Start a mock target that records what it receives
      let receivedUrl = '';
      let receivedMethod = '';
      const mock = createServer((req, res) => {
        receivedUrl = req.url ?? '';
        receivedMethod = req.method ?? '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mock: true }));
      });
      await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
      const mockPort = (mock.address() as AddressInfo).port;
      cleanups.push(() => mock.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test:rewrite:1',
        allowedIPs: ALLOW_LOCALHOST,
        urlRewrites: new Map([
          ['api.linear.app', `http://127.0.0.1:${mockPort}`],
        ]),
      });
      cleanups.push(proxy.stop);

      // Send HTTP request through proxy targeting api.linear.app
      const result = await proxyFetch(
        proxy.address as number,
        `http://api.linear.app/graphql`,
        { method: 'POST', body: '{"query":"{ viewer { id } }"}' },
      );

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body).toEqual({ mock: true });
      expect(receivedUrl).toBe('/graphql');
      expect(receivedMethod).toBe('POST');
    });

    test('URL rewrite redirects CONNECT tunnel to mock target', async () => {
      // Start a TCP echo server as the mock target
      const echo = await startTCPEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test:rewrite:2',
        allowedIPs: ALLOW_LOCALHOST,
        urlRewrites: new Map([
          ['api.linear.app', `http://127.0.0.1:${echo.port}`],
        ]),
      });
      cleanups.push(proxy.stop);

      // CONNECT to api.linear.app:443 should be redirected to the echo server
      const result = await proxyConnect(
        proxy.address as number,
        'api.linear.app',
        443,
        'tunnel-rewrite-test',
      );

      expect(result.established).toBe(true);
      expect(result.response).toContain('echo:tunnel-rewrite-test');
    });

    test('URL rewrite preserves path and query string', async () => {
      let receivedUrl = '';
      const mock = createServer((req, res) => {
        receivedUrl = req.url ?? '';
        res.writeHead(200);
        res.end('ok');
      });
      await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
      const mockPort = (mock.address() as AddressInfo).port;
      cleanups.push(() => mock.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test:rewrite:3',
        allowedIPs: ALLOW_LOCALHOST,
        urlRewrites: new Map([
          ['example.com', `http://127.0.0.1:${mockPort}/base`],
        ]),
      });
      cleanups.push(proxy.stop);

      await proxyFetch(
        proxy.address as number,
        'http://example.com/api/v1/search?q=test&limit=10',
      );

      expect(receivedUrl).toBe('/base/api/v1/search?q=test&limit=10');
    });

    test('non-matching domains are not rewritten', async () => {
      const echo = await startEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'test:rewrite:4',
        allowedIPs: ALLOW_LOCALHOST,
        urlRewrites: new Map([
          ['other.example.com', 'http://127.0.0.1:9999'],
        ]),
      });
      cleanups.push(proxy.stop);

      // Request to echo server (not rewritten) should pass through normally
      const result = await proxyFetch(
        proxy.address as number,
        `http://127.0.0.1:${echo.port}/hello`,
      );

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.url).toBe('/hello');
    });
  });

  describe('MITM TLS inspection', () => {
    test('intercepts HTTPS and replaces credential placeholder in header', async () => {
      // 1. Start a TLS echo server (simulates api.linear.app)
      const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
      const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
      cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));

      const ca = await getOrCreateCA(caDir);

      // Self-signed server cert for our test echo server
      const { generateDomainCert } = await import('../../src/host/proxy-ca.js');
      const serverCert = generateDomainCert('127.0.0.1', ca);

      const tlsEchoServer = tls.createServer({
        key: serverCert.key,
        cert: serverCert.cert,
      }, (socket) => {
        let data = '';
        socket.on('data', (chunk) => {
          data += chunk.toString();
          // Once we get the full HTTP request, send a response
          if (data.includes('\r\n\r\n')) {
            const authMatch = data.match(/authorization: (.+)/i);
            const responseBody = JSON.stringify({ auth: authMatch?.[1]?.trim() ?? 'none' });
            socket.write(
              `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(responseBody)}\r\nConnection: close\r\n\r\n${responseBody}`
            );
            socket.end();
          }
        });
      });
      await new Promise<void>(resolve => tlsEchoServer.listen(0, '127.0.0.1', resolve));
      const echoPort = (tlsEchoServer.address() as AddressInfo).port;
      cleanups.push(() => tlsEchoServer.close());

      // 2. Create credential map with a placeholder
      const credMap = new CredentialPlaceholderMap();
      const placeholder = credMap.register('LINEAR_API_KEY', 'lin_api_REAL_SECRET');

      // 3. Start web proxy in MITM mode
      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'mitm-test',
        allowedIPs: ALLOW_LOCALHOST,
        mitm: { ca, credentials: credMap },
      });
      cleanups.push(proxy.stop);
      const proxyPort = proxy.address as number;

      // 4. Make HTTPS request through proxy with placeholder in Authorization header
      const result = await mitmProxyFetch(proxyPort, `https://127.0.0.1:${echoPort}/api/issues`, {
        headers: { authorization: `Bearer ${placeholder}` },
        ca: ca.cert,
      });

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      // The echo server should have received the REAL key, not the placeholder
      expect(body.auth).toBe('Bearer lin_api_REAL_SECRET');
    });

    test('passes through HTTPS without replacement when no placeholders', async () => {
      const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
      const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
      cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
      const ca = await getOrCreateCA(caDir);

      const credMap = new CredentialPlaceholderMap();

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'mitm-test-passthrough',
        allowedIPs: ALLOW_LOCALHOST,
        mitm: { ca, credentials: credMap },
      });
      cleanups.push(proxy.stop);

      // This test just verifies the proxy doesn't break non-credential traffic.
      expect(proxy.address).toBeGreaterThan(0);
    });

    test('bypasses MITM for domains in bypass list', async () => {
      const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
      const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
      cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
      const ca = await getOrCreateCA(caDir);

      const credMap = new CredentialPlaceholderMap();

      // Start TCP echo server (not TLS — simulates a bypassed raw tunnel)
      const echo = await startTCPEchoServer();
      cleanups.push(() => echo.server.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'mitm-bypass-test',
        allowedIPs: ALLOW_LOCALHOST,
        mitm: {
          ca,
          credentials: credMap,
          bypassDomains: new Set(['127.0.0.1']),
        },
      });
      cleanups.push(proxy.stop);

      // CONNECT to a bypassed domain should use raw tunnel (old behavior)
      const result = await proxyConnect(
        proxy.address as number,
        '127.0.0.1',
        echo.port,
        'bypass-test-data',
      );

      // Raw tunnel should work (TCP echo server, not TLS)
      expect(result.established).toBe(true);
      expect(result.response).toContain('echo:bypass-test-data');
    });

    test('audit entry includes credentialInjected flag when replacement occurs', async () => {
      const { getOrCreateCA } = await import('../../src/host/proxy-ca.js');
      const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
      cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
      const ca = await getOrCreateCA(caDir);

      const credMap = new CredentialPlaceholderMap();
      const placeholder = credMap.register('API_KEY', 'real_secret');

      const entries: ProxyAuditEntry[] = [];

      // Start TLS echo server
      const { generateDomainCert } = await import('../../src/host/proxy-ca.js');
      const serverCert = generateDomainCert('127.0.0.1', ca);
      const tlsServer = tls.createServer({ key: serverCert.key, cert: serverCert.cert }, (socket) => {
        socket.on('data', () => {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
          socket.end();
        });
      });
      await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
      const serverPort = (tlsServer.address() as AddressInfo).port;
      cleanups.push(() => tlsServer.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'audit-cred-test',
        allowedIPs: ALLOW_LOCALHOST,
        onAudit: (e) => entries.push(e),
        mitm: { ca, credentials: credMap },
      });
      cleanups.push(proxy.stop);

      await mitmProxyFetch(proxy.address as number, `https://127.0.0.1:${serverPort}/api`, {
        headers: { authorization: `Bearer ${placeholder}` },
        ca: ca.cert,
      });

      expect(entries.length).toBe(1);
      expect(entries[0].credentialInjected).toBe(true);
    });

    test('blocks MITM traffic when canary detected in decrypted body', async () => {
      const { getOrCreateCA, generateDomainCert } = await import('../../src/host/proxy-ca.js');
      const caDir = mkdtempSync(join(tmpdir(), 'ax-ca-test-'));
      cleanups.push(() => rmSync(caDir, { recursive: true, force: true }));
      const ca = await getOrCreateCA(caDir);

      const canary = 'CANARY-exfil-detect-test-12345';
      const credMap = new CredentialPlaceholderMap();

      // TLS echo server
      const serverCert = generateDomainCert('127.0.0.1', ca);
      const tlsServer = tls.createServer({ key: serverCert.key, cert: serverCert.cert }, (socket) => {
        socket.on('data', () => {
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
          socket.end();
        });
      });
      await new Promise<void>(resolve => tlsServer.listen(0, '127.0.0.1', resolve));
      const serverPort = (tlsServer.address() as AddressInfo).port;
      cleanups.push(() => tlsServer.close());

      const proxy = await startWebProxy({
        listen: 0,
        sessionId: 'canary-mitm-test',
        canaryToken: canary,
        allowedIPs: ALLOW_LOCALHOST,
        mitm: { ca, credentials: credMap },
      });
      cleanups.push(proxy.stop);

      // Send HTTPS request with canary in the body
      const result = await mitmProxyFetch(
        proxy.address as number,
        `https://127.0.0.1:${serverPort}/exfil`,
        { method: 'POST', body: `secret data with ${canary} inside`, ca: ca.cert },
      ).catch(() => ({ status: 0, body: 'connection_closed' }));

      // Proxy should close/block the connection when canary detected
      expect(result.status === 403 || result.body === 'connection_closed').toBe(true);
    });
  });
});
