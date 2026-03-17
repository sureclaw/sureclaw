/**
 * HTTP forward proxy for sandboxed agents.
 *
 * Allows agents to make outbound HTTP/HTTPS requests (npm install, pip install,
 * curl, git clone) through a controlled proxy running on the host.
 *
 * Two request types:
 * - HTTP forwarding: receives full HTTP request, forwards it, streams response back
 * - HTTPS CONNECT tunneling: receives CONNECT host:port, establishes raw TCP
 *   connection, pipes bytes bidirectionally. Proxy never sees TLS plaintext.
 *
 * Security:
 * - Private IP blocking prevents SSRF against cloud metadata, internal services
 * - Canary token scanning on HTTP request bodies prevents exfiltration
 * - All requests audit-logged with method, URL, status, bytes, duration
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as net from 'node:net';
import { lookup } from 'node:dns/promises';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'web-proxy' });

// ── Types ────────────────────────────────────────────────────────────

export interface WebProxy {
  /** Port number (TCP mode) or socket path (Unix socket mode). */
  address: string | number;
  stop: () => void;
}

export interface ProxyAuditEntry {
  action: 'proxy_request';
  sessionId: string;
  method: string;
  url: string;
  status: number;
  requestBytes: number;
  responseBytes: number;
  durationMs: number;
  blocked?: string;
}

export interface WebProxyOptions {
  /** Unix socket path OR TCP port number (0 = ephemeral). */
  listen: string | number;
  /** Session ID for audit logging context. */
  sessionId: string;
  /** Canary token to scan for in outbound request bodies. */
  canaryToken?: string;
  /** Audit log callback — wired to audit provider by host. */
  onAudit?: (entry: ProxyAuditEntry) => void;
  /** IPs exempt from private-range blocking (for testing). */
  allowedIPs?: Set<string>;
}

// ── Private IP blocking ──────────────────────────────────────────────

/** IPv4 ranges that must never be connected to (SSRF protection). */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                              // 127.0.0.0/8
    a === 10 ||                               // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12
    (a === 192 && b === 168) ||               // 192.168.0.0/16
    (a === 169 && b === 254) ||               // 169.254.0.0/16 (cloud metadata)
    a === 0                                    // 0.0.0.0/8
  );
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  return norm === '::1' || norm === '::' || norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd');
}

/**
 * Resolve hostname and check against private IP ranges.
 * Returns the resolved IP or throws if private.
 */
async function resolveAndCheck(hostname: string, allowedIPs?: Set<string>): Promise<string> {
  // Literal IP — no DNS lookup needed
  if (net.isIP(hostname)) {
    if (!allowedIPs?.has(hostname) && (isPrivateIPv4(hostname) || isPrivateIPv6(hostname))) {
      throw new Error(`Blocked: private IP ${hostname}`);
    }
    return hostname;
  }

  const result = await lookup(hostname);
  const ip = result.address;

  if (!allowedIPs?.has(ip) && (isPrivateIPv4(ip) || isPrivateIPv6(ip))) {
    throw new Error(`Blocked: ${hostname} resolved to private IP ${ip}`);
  }
  return ip;
}

// ── Canary scanning ──────────────────────────────────────────────────

/** Check if a request body contains a canary token. */
function containsCanary(body: Buffer, canaryToken?: string): boolean {
  if (!canaryToken) return false;
  return body.includes(canaryToken);
}

// ── Proxy implementation ─────────────────────────────────────────────

export async function startWebProxy(options: WebProxyOptions): Promise<WebProxy> {
  const { listen, sessionId, canaryToken, onAudit, allowedIPs } = options;
  const activeSockets = new Set<net.Socket>();

  function audit(entry: ProxyAuditEntry): void {
    onAudit?.(entry);
    logger.debug('proxy_request', {
      method: entry.method,
      url: entry.url,
      status: entry.status,
      requestBytes: entry.requestBytes,
      responseBytes: entry.responseBytes,
      durationMs: entry.durationMs,
      blocked: entry.blocked,
    });
  }

  // ── HTTP request forwarding ──

  async function handleHTTPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let requestBytes = 0;
    let responseBytes = 0;

    try {
      // Parse the full URL from the request
      const targetUrl = new URL(url);

      // Resolve and check for private IPs
      const hostname = targetUrl.hostname.startsWith('[') && targetUrl.hostname.endsWith(']')
        ? targetUrl.hostname.slice(1, -1)
        : targetUrl.hostname;

      await resolveAndCheck(hostname, allowedIPs);

      // Read request body
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk as Buffer);
      }
      const body = Buffer.concat(chunks);
      requestBytes = body.length;

      // Canary scanning on request body
      if (containsCanary(body, canaryToken)) {
        audit({
          action: 'proxy_request',
          sessionId,
          method,
          url,
          status: 403,
          requestBytes,
          responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: 'canary_detected',
        });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Blocked: canary token detected in request body');
        return;
      }

      // Forward headers (strip hop-by-hop and encoding headers — fetch handles these)
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value || key === 'host' || key === 'connection' || key === 'proxy-connection'
            || key === 'transfer-encoding' || key === 'content-length') continue;
        headers[key] = Array.isArray(value) ? value.join(', ') : value;
      }

      // Forward the request using fetch (streams response)
      const response = await fetch(url, {
        method,
        headers,
        body: body.length > 0 ? body : undefined,
        redirect: 'follow',
      });

      // Stream response back
      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        if (k !== 'transfer-encoding' && k !== 'content-encoding' && k !== 'content-length') {
          outHeaders[k] = v;
        }
      });
      res.writeHead(response.status, outHeaders);

      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            responseBytes += value.length;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
      }
      res.end();

      audit({
        action: 'proxy_request',
        sessionId,
        method,
        url,
        status: response.status,
        requestBytes,
        responseBytes,
        durationMs: Date.now() - startTime,
      });
    } catch (err) {
      const blocked = (err as Error).message?.startsWith('Blocked:')
        ? (err as Error).message
        : undefined;
      const status = blocked ? 403 : 502;

      if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'text/plain' });
      }
      res.end(blocked ?? `Proxy error: ${(err as Error).message}`);

      audit({
        action: 'proxy_request',
        sessionId,
        method,
        url,
        status,
        requestBytes,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked,
      });
    }
  }

  // ── CONNECT tunneling ──

  async function handleCONNECT(
    req: IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const startTime = Date.now();
    const target = req.url ?? '';
    let requestBytes = head.length;
    let responseBytes = 0;

    // Parse host:port from CONNECT target
    const [hostname, portStr] = target.split(':');
    const port = parseInt(portStr ?? '443', 10);

    if (!hostname || Number.isNaN(port)) {
      clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      clientSocket.end();
      audit({
        action: 'proxy_request',
        sessionId,
        method: 'CONNECT',
        url: target,
        status: 400,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked: 'invalid_target',
      });
      return;
    }

    try {
      // Resolve and check for private IPs
      const resolvedIP = await resolveAndCheck(hostname, allowedIPs);

      // Connect to target
      const targetSocket = net.connect(port, resolvedIP, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        activeSockets.add(targetSocket);

        // Pipe bidirectionally
        targetSocket.pipe(clientSocket);
        clientSocket.pipe(targetSocket);

        // Write any buffered data
        if (head.length > 0) {
          targetSocket.write(head);
        }

        // Track bytes
        targetSocket.on('data', (chunk: Buffer) => { responseBytes += chunk.length; });
        clientSocket.on('data', (chunk: Buffer) => { requestBytes += chunk.length; });
      });

      // Cleanup on close/error (once only)
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        activeSockets.delete(targetSocket);
        targetSocket.destroy();
        clientSocket.destroy();

        audit({
          action: 'proxy_request',
          sessionId,
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
        });
      };

      targetSocket.on('close', cleanup);
      targetSocket.on('error', cleanup);
      clientSocket.on('close', cleanup);
      clientSocket.on('error', cleanup);
    } catch (err) {
      const blocked = (err as Error).message?.startsWith('Blocked:')
        ? (err as Error).message
        : undefined;
      const status = blocked ? 403 : 502;

      clientSocket.write(`HTTP/1.1 ${status} ${blocked ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`);
      clientSocket.end();

      audit({
        action: 'proxy_request',
        sessionId,
        method: 'CONNECT',
        url: target,
        status,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: Date.now() - startTime,
        blocked,
      });
    }
  }

  // ── Server setup ──

  const server: Server = createServer(handleHTTPRequest);
  server.on('connect', handleCONNECT);

  // Clean up stale Unix socket
  if (typeof listen === 'string' && existsSync(listen)) {
    unlinkSync(listen);
  }

  const stopFn = () => {
    for (const s of activeSockets) s.destroy();
    activeSockets.clear();
    server.close();
    if (typeof listen === 'string') {
      try { unlinkSync(listen); } catch { /* ignore */ }
    }
  };

  if (typeof listen === 'string') {
    // Unix socket mode
    await new Promise<void>((resolve) => {
      server.listen(listen, () => resolve());
    });
    return { address: listen, stop: stopFn };
  } else {
    // TCP mode — wait for listen callback to get the assigned port
    const port = await new Promise<number>((resolve) => {
      server.listen(listen, '127.0.0.1', () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
    return { address: port, stop: stopFn };
  }
}
