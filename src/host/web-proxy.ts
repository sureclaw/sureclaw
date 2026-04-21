/**
 * HTTP forward proxy for sandboxed agents.
 *
 * Allows agents to make outbound HTTP/HTTPS requests (npm install, pip install,
 * curl, git clone) through a controlled proxy running on the host.
 *
 * Three request modes:
 * - HTTP forwarding: receives full HTTP request, forwards it, streams response back
 * - HTTPS CONNECT tunneling: receives CONNECT host:port, establishes raw TCP
 *   connection, pipes bytes bidirectionally. Proxy never sees TLS plaintext.
 * - MITM TLS inspection: when enabled, CONNECT requests are intercepted with a
 *   dynamically-generated domain cert. Decrypted traffic is scanned for credential
 *   placeholders (replaced with real values) and canary tokens (blocked).
 *
 * Security:
 * - Private IP blocking prevents SSRF against cloud metadata, internal services
 * - Canary token scanning on HTTP request bodies prevents exfiltration
 * - All requests audit-logged with method, URL, status, bytes, duration
 */

import { createServer, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { lookup } from 'node:dns/promises';
import { existsSync, unlinkSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { getLogger } from '../logger.js';
import { applyUrlRewrite } from '../plugins/url-rewrite.js';
import type { CAKeyPair } from './proxy-ca.js';
// CredentialPlaceholderMap and SharedCredentialRegistry both satisfy the
// credentials duck-type ({ replaceAllBuffer, hasPlaceholders }).

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
  credentialInjected?: boolean;
}

export interface WebProxyOptions {
  /** Unix socket path OR TCP port number (0 = ephemeral). */
  listen: string | number;
  /** Bind address for TCP mode. Defaults to '127.0.0.1'.
   *  Use '0.0.0.0' when the proxy must be reachable from other pods (k8s). */
  bindHost?: string;
  /** Session ID for audit logging context. */
  sessionId: string;
  /** Canary token to scan for in outbound request bodies. */
  canaryToken?: string;
  /** Audit log callback — wired to audit provider by host. */
  onAudit?: (entry: ProxyAuditEntry) => void;
  /** IPs exempt from private-range blocking (for testing). */
  allowedIPs?: Set<string>;
  /**
   * Governance gate — called before forwarding a request to a new domain.
   * The proxy caches decisions per domain for the session lifetime, so this
   * is called at most once per unique domain.
   *
   * When not provided, all public-IP requests are auto-approved (existing behavior).
   */
  onApprove?: (domain: string, method: string, url: string) => Promise<{ approved: boolean; reason?: string }>;
  /** Domains pre-approved without calling onApprove (e.g. from config allowlist).
   *  Accepts any object with a `has()` method — the host computes a per-session
   *  frozen Set at session start and hands its `has` in here. */
  allowedDomains?: { has(domain: string): boolean };
  /**
   * MITM TLS inspection config. When provided, CONNECT requests are intercepted:
   * the proxy terminates TLS with a dynamically-generated cert, inspects/modifies
   * traffic (credential placeholder replacement), then forwards to the real server.
   * Without this, CONNECT is a blind TCP tunnel (existing behavior).
   */
  mitm?: {
    ca: CAKeyPair;
    credentials: { replaceAllBuffer(input: Buffer): Buffer; hasPlaceholders(input: string): boolean };
    /** Domains that bypass MITM inspection (cert-pinning CLIs). Raw TCP tunnel. */
    bypassDomains?: Set<string>;
  };
  /**
   * URL rewrite map: domain -> replacement base URL.
   * When a request targets a domain in this map, the proxy rewrites the URL
   * to use the replacement base URL instead.
   * Works for both HTTP forwarding and HTTPS CONNECT tunneling.
   */
  urlRewrites?: Map<string, string>;
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
  const { listen, bindHost = '127.0.0.1', sessionId, canaryToken, onAudit, allowedIPs, onApprove, allowedDomains, urlRewrites } = options;
  const activeSockets = new Set<net.Socket>();
  /** Per-domain decision cache — avoids repeated callbacks for the same domain. */
  const domainDecisions = new Map<string, boolean>();

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

  /**
   * Check whether a domain is approved. Returns null if approved,
   * or a block reason string if denied.
   */
  async function checkDomainApproval(domain: string, method: string, url: string): Promise<string | null> {
    // Pre-approved via config allowlist
    if (allowedDomains?.has(domain)) return null;

    // Cached approval from a previous request in this session
    if (domainDecisions.get(domain) === true) return null;

    if (!onApprove) {
      // No governance gate — deny if an allowlist was provided but domain isn't in it
      if (allowedDomains) {
        logger.warn('domain_denied', { domain, method, url });
        return `Domain ${domain} is not in the approved domain list. Install a skill that declares this domain, or ask an admin to approve it.`;
      }
      return null; // No allowlist configured — auto-approve (backward compat)
    }

    // Existing onApprove path (kept for backward compat)
    const decision = await onApprove(domain, method, url);
    // Only cache approvals — denials may be retried.
    if (decision.approved) domainDecisions.set(domain, true);
    if (!decision.approved) {
      return decision.reason ?? `Network access to ${domain} was denied`;
    }
    return null;
  }

  /** Rewrite URL if domain matches a urlRewrites entry. Returns original if no match.
   *  Thin wrapper around the shared `applyUrlRewrite` helper — same semantics,
   *  exported so the MCP client (which runs on the host, bypassing this proxy)
   *  can reuse the rewrite map. */
  function rewriteUrl(originalUrl: string): string {
    return applyUrlRewrite(originalUrl, urlRewrites);
  }

  // ── HTTP request forwarding ──

  async function handleHTTPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const startTime = Date.now();
    const method = req.method ?? 'GET';
    const url = req.url ?? '/';
    let requestBytes = 0;
    let responseBytes = 0;

    try {
      // Apply URL rewrite if domain matches
      const rewrittenUrl = rewriteUrl(url);
      const targetUrl = new URL(rewrittenUrl);

      // Resolve and check for private IPs
      const hostname = targetUrl.hostname.startsWith('[') && targetUrl.hostname.endsWith(']')
        ? targetUrl.hostname.slice(1, -1)
        : targetUrl.hostname;

      await resolveAndCheck(hostname, allowedIPs);

      // Governance gate — check domain approval before forwarding
      const blockReason = await checkDomainApproval(hostname, method, url);
      if (blockReason) {
        audit({
          action: 'proxy_request', sessionId, method, url,
          status: 403, requestBytes: 0, responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
        });
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(blockReason);
        return;
      }

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
      const response = await fetch(rewrittenUrl, {
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
      // URL rewrite — redirect CONNECT tunnel to mock target
      const rewriteTarget = urlRewrites?.get(hostname);
      if (rewriteTarget) {
        const rTarget = new URL(rewriteTarget);
        const connectHost = rTarget.hostname;
        const connectPort = parseInt(rTarget.port || (rTarget.protocol === 'https:' ? '443' : '80'));
        const socket = net.connect(connectPort, connectHost, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          socket.pipe(clientSocket);
          clientSocket.pipe(socket);
        });
        socket.on('error', () => {
          clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        });
        clientSocket.on('error', () => { socket.destroy(); });
        return;
      }

      // Governance gate — check domain approval before tunneling
      const blockReason = await checkDomainApproval(hostname, 'CONNECT', target);
      if (blockReason) {
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.end();
        audit({
          action: 'proxy_request', sessionId, method: 'CONNECT', url: target,
          status: 403, requestBytes: 0, responseBytes: 0,
          durationMs: Date.now() - startTime,
          blocked: `domain_denied: ${hostname}`,
        });
        return;
      }

      // Resolve and check for private IPs
      const resolvedIP = await resolveAndCheck(hostname, allowedIPs);

      // Check if MITM inspection should be used for this connection
      const shouldMitm = options.mitm && !options.mitm.bypassDomains?.has(hostname);

      if (shouldMitm) {
        await handleMITMConnect(clientSocket, hostname, port, resolvedIP, head, startTime, target);
        return;
      }

      // Connect to target (raw TCP tunnel — existing behavior)
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

  // ── MITM TLS inspection ──

  async function handleMITMConnect(
    clientSocket: net.Socket,
    hostname: string,
    port: number,
    resolvedIP: string,
    head: Buffer,
    startTime: number,
    target: string,
  ): Promise<void> {
    const { generateDomainCert } = await import('./proxy-ca.js');
    const domainCert = generateDomainCert(hostname, options.mitm!.ca);
    const credentials = options.mitm!.credentials;

    // Tell client the tunnel is established
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    // Handle errors on the raw socket to prevent unhandled 'error' crashes
    // (e.g. ECONNRESET when the client disconnects abruptly during MITM)
    clientSocket.on('error', () => { /* handled by TLS wrapper cleanup */ });

    // Terminate TLS on the client side with our generated cert
    const clientTls = new tls.TLSSocket(clientSocket, {
      isServer: true,
      key: domainCert.key,
      cert: domainCert.cert,
    });

    // Connect to the real target with TLS — verify the upstream cert.
    // Extend the default trust store with our MITM CA so test targets
    // (signed by the same CA) are trusted without disabling verification.
    const targetTls = tls.connect({
      host: resolvedIP,
      port,
      servername: hostname,
      ca: [...tls.rootCertificates, options.mitm!.ca.cert],
    });

    activeSockets.add(clientTls);
    activeSockets.add(targetTls);

    // Handle upstream TLS handshake failures with accurate audit status
    let tlsFailed = false;
    targetTls.on('error', (err) => {
      if (!tlsFailed) {
        tlsFailed = true;
        audit({
          action: 'proxy_request', sessionId, method: 'CONNECT', url: target,
          status: 502, requestBytes: head.length, responseBytes: 0,
          durationMs: Date.now() - startTime, blocked: `tls_error: ${err.message}`,
        });
      }
    });

    let requestBytes = head.length;
    let responseBytes = 0;
    let credentialInjected = false;

    // Pipe client → (replace credentials, scan canary) → target
    clientTls.on('data', (chunk: Buffer) => {
      requestBytes += chunk.length;

      // Canary scanning on decrypted HTTPS traffic
      if (canaryToken && chunk.includes(canaryToken)) {
        audit({
          action: 'proxy_request', sessionId, method: 'CONNECT', url: target,
          status: 403, requestBytes, responseBytes: 0,
          durationMs: Date.now() - startTime, blocked: 'canary_detected',
        });
        // Send a 403 response over the TLS channel before tearing down
        clientTls.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        clientTls.end();
        targetTls.destroy();
        return;
      }

      const replaced = credentials.replaceAllBuffer(chunk);
      if (replaced !== chunk) credentialInjected = true;
      targetTls.write(replaced);
    });

    // Pipe target → client (no replacement needed on responses)
    targetTls.on('data', (chunk: Buffer) => {
      responseBytes += chunk.length;
      clientTls.write(chunk);
    });

    // Write any buffered data from CONNECT handshake
    if (head.length > 0) {
      const replaced = credentials.replaceAllBuffer(head);
      if (replaced !== head) credentialInjected = true;
      targetTls.write(replaced);
    }

    // Cleanup
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeSockets.delete(clientTls);
      activeSockets.delete(targetTls);
      clientTls.destroy();
      targetTls.destroy();

      // Skip audit if TLS handshake error already logged with accurate status
      if (!tlsFailed) {
        audit({
          action: 'proxy_request',
          sessionId,
          method: 'CONNECT',
          url: target,
          status: 200,
          requestBytes,
          responseBytes,
          durationMs: Date.now() - startTime,
          credentialInjected: credentialInjected || undefined,
        });
      }
    };

    clientTls.on('close', cleanup);
    clientTls.on('error', cleanup);
    targetTls.on('close', cleanup);
    targetTls.on('error', cleanup);
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
      server.listen(listen, bindHost, () => {
        resolve((server.address() as AddressInfo).port);
      });
    });
    return { address: port, stop: stopFn };
  }
}
