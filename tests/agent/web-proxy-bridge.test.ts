import { describe, test, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import * as net from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { startWebProxyBridge, type WebProxyBridge } from '../../src/agent/web-proxy-bridge.js';

// ── Test helpers ─────────────────────────────────────────────────────

/**
 * Start a mock HTTP forward proxy on a Unix socket.
 * This simulates the host-side web proxy that the bridge connects to.
 * Handles both regular HTTP requests and CONNECT tunneling.
 */
function startMockProxy(socketPath: string): Promise<{ server: Server }> {
  // Clean up stale socket
  try { unlinkSync(socketPath); } catch { /* ignore */ }

  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      // Mock proxy: echo request info back as JSON
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          proxied: true,
          method: req.method,
          url: req.url,
          body,
        }));
      });
    });

    // Handle CONNECT for tunnel testing
    server.on('connect', (req: any, clientSocket: net.Socket, head: Buffer) => {
      const target = req.url ?? '';
      const [host, portStr] = target.split(':');
      const port = parseInt(portStr ?? '0', 10);

      if (host && port) {
        // Connect to actual target (used in bridge tunnel tests)
        const targetSocket = net.connect(port, host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length > 0) targetSocket.write(head);
          targetSocket.pipe(clientSocket);
          clientSocket.pipe(targetSocket);
        });
        targetSocket.on('error', () => {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
          clientSocket.end();
        });
      } else {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.end();
      }
    });

    server.listen(socketPath, () => resolve({ server }));
  });
}

/** Start a TCP echo server for CONNECT testing. */
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

/** Make an HTTP request through the bridge using http.request (proxy mode). */
async function bridgeFetch(
  bridgePort: number,
  targetUrl: string,
  opts?: { method?: string; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = require('node:http').request({
      host: '127.0.0.1',
      port: bridgePort,
      method: opts?.method ?? 'GET',
      path: targetUrl,
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

/** Send a CONNECT request through the bridge. */
async function bridgeConnect(
  bridgePort: number,
  targetHost: string,
  targetPort: number,
  data: string,
): Promise<{ established: boolean; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(bridgePort, '127.0.0.1', () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
    });

    let buffer = '';
    let established = false;

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!established && buffer.includes('\r\n\r\n')) {
        established = buffer.startsWith('HTTP/1.1 200');
        if (established) {
          socket.write(data);
        } else {
          socket.end();
          resolve({ established: false, response: buffer });
        }
      } else if (established && buffer.includes('echo:')) {
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

describe('web-proxy-bridge', () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanups) {
      try { fn(); } catch { /* ignore */ }
    }
    cleanups.length = 0;
  });

  test('module exports startWebProxyBridge function', async () => {
    const mod = await import('../../src/agent/web-proxy-bridge.js');
    expect(typeof mod.startWebProxyBridge).toBe('function');
  });

  test('starts on ephemeral port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ax-bridge-test-'));
    const socketPath = join(dir, 'web-proxy.sock');
    const mock = await startMockProxy(socketPath);
    cleanups.push(() => mock.server.close());

    const bridge = await startWebProxyBridge(socketPath);
    cleanups.push(bridge.stop);

    expect(bridge.port).toBeGreaterThan(0);
  });

  describe('HTTP forwarding through bridge', () => {
    test('forwards GET requests to proxy via Unix socket', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-bridge-test-'));
      const socketPath = join(dir, 'web-proxy.sock');
      const mock = await startMockProxy(socketPath);
      cleanups.push(() => mock.server.close());

      const bridge = await startWebProxyBridge(socketPath);
      cleanups.push(bridge.stop);

      const result = await bridgeFetch(bridge.port, 'http://example.com/test');

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.proxied).toBe(true);
      expect(body.method).toBe('GET');
    });

    test('forwards POST requests with body', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-bridge-test-'));
      const socketPath = join(dir, 'web-proxy.sock');
      const mock = await startMockProxy(socketPath);
      cleanups.push(() => mock.server.close());

      const bridge = await startWebProxyBridge(socketPath);
      cleanups.push(bridge.stop);

      const result = await bridgeFetch(
        bridge.port,
        'http://example.com/upload',
        { method: 'POST', body: 'test-data' },
      );

      expect(result.status).toBe(200);
      const body = JSON.parse(result.body);
      expect(body.proxied).toBe(true);
      expect(body.method).toBe('POST');
      expect(body.body).toBe('test-data');
    });
  });

  describe('CONNECT tunneling through bridge', () => {
    test('tunnels CONNECT through bridge → Unix socket → proxy → target', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-bridge-test-'));
      const socketPath = join(dir, 'web-proxy.sock');
      const mock = await startMockProxy(socketPath);
      cleanups.push(() => mock.server.close());

      const echo = await startTCPEchoServer();
      cleanups.push(() => echo.server.close());

      const bridge = await startWebProxyBridge(socketPath);
      cleanups.push(bridge.stop);

      const result = await bridgeConnect(
        bridge.port,
        '127.0.0.1',
        echo.port,
        'tunnel-test',
      );

      expect(result.established).toBe(true);
      expect(result.response).toContain('echo:tunnel-test');
    });
  });

  describe('cleanup', () => {
    test('stop() closes server and connections', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'ax-bridge-test-'));
      const socketPath = join(dir, 'web-proxy.sock');
      const mock = await startMockProxy(socketPath);
      cleanups.push(() => mock.server.close());

      const bridge = await startWebProxyBridge(socketPath);
      bridge.stop();

      // Server should be closed — new connections should fail
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = await new Promise<boolean>((resolve) => {
        const socket = net.connect(bridge.port, '127.0.0.1');
        socket.on('error', () => resolve(true));
        socket.on('connect', () => { socket.end(); resolve(false); });
        setTimeout(() => resolve(true), 500);
      });

      expect(result).toBe(true);
    });
  });
});
