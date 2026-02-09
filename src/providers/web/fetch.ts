import { lookup } from 'node:dns/promises';
import type { WebProvider, FetchRequest, FetchResponse, Config, TaintTag } from '../types.js';

const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
const DEFAULT_TIMEOUT_MS = 10_000;

/** IPv4 ranges that must never be fetched (SSRF protection). */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                              // 127.0.0.0/8
    a === 10 ||                               // 10.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12
    (a === 192 && b === 168) ||               // 192.168.0.0/16
    (a === 169 && b === 254) ||               // 169.254.0.0/16 (link-local / cloud metadata)
    a === 0                                    // 0.0.0.0/8
  );
}

function isPrivateIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  return norm === '::1' || norm === '::' || norm.startsWith('fe80:') || norm.startsWith('fc') || norm.startsWith('fd');
}

function taintTag(): TaintTag {
  return { source: 'web_fetch', trust: 'external', timestamp: new Date() };
}

/**
 * Resolve hostname to IP and verify it is not a private address.
 * This is DNS pinning — we resolve once, check the IP, then connect
 * to that exact IP. Prevents TOCTOU DNS rebinding attacks.
 */
async function resolveSafe(hostname: string, allowedIPs?: Set<string>): Promise<string> {
  const result = await lookup(hostname);
  const ip = result.address;

  if (!allowedIPs?.has(ip) && (isPrivateIPv4(ip) || isPrivateIPv6(ip))) {
    throw new Error(`Blocked: ${hostname} resolved to private IP ${ip}`);
  }
  return ip;
}

export interface WebFetchOptions {
  /** IPs exempt from private-range blocking (for testing). */
  allowedIPs?: Set<string>;
}

export async function create(_config: Config, opts?: WebFetchOptions): Promise<WebProvider> {
  const allowedIPs = opts?.allowedIPs;

  function isBlocked(ip: string): boolean {
    if (allowedIPs?.has(ip)) return false;
    return isPrivateIPv4(ip) || isPrivateIPv6(ip);
  }

  return {
    async fetch(req: FetchRequest): Promise<FetchResponse> {
      const url = new URL(req.url);

      // Protocol check
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Unsupported protocol: ${url.protocol}`);
      }

      // Extract hostname — handle IPv6 bracket notation
      const rawHost = url.hostname;
      const hostname = rawHost.startsWith('[') && rawHost.endsWith(']')
        ? rawHost.slice(1, -1)
        : rawHost;

      // Check literal IPs directly (no DNS needed)
      if (isBlocked(hostname)) {
        throw new Error(`Blocked: private IP ${hostname}`);
      }

      // DNS pinning — resolve and verify
      const pinnedIP = await resolveSafe(hostname, allowedIPs);

      // Build fetch URL using pinned IP
      const pinnedUrl = new URL(req.url);
      if (pinnedIP.includes(':')) {
        pinnedUrl.hostname = `[${pinnedIP}]`;
      } else {
        pinnedUrl.hostname = pinnedIP;
      }

      const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const resp = await globalThis.fetch(pinnedUrl.toString(), {
          method: req.method ?? 'GET',
          headers: {
            ...req.headers,
            Host: url.host, // Original host for SNI / virtual hosting
          },
          signal: controller.signal,
          redirect: 'follow',
        });

        // Read body with size limit
        const reader = resp.body?.getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;

        if (reader && req.method !== 'HEAD') {
          while (totalBytes < MAX_BODY_BYTES) {
            const { done, value } = await reader.read();
            if (done) break;
            const remaining = MAX_BODY_BYTES - totalBytes;
            if (value.length > remaining) {
              chunks.push(value.slice(0, remaining));
              totalBytes += remaining;
              break;
            }
            chunks.push(value);
            totalBytes += value.length;
          }
          reader.cancel().catch(() => {});
        }

        const body = new TextDecoder().decode(
          chunks.length === 1
            ? chunks[0]
            : chunks.reduce((acc, c) => {
                const merged = new Uint8Array(acc.length + c.length);
                merged.set(acc);
                merged.set(c, acc.length);
                return merged;
              }, new Uint8Array(0)),
        );

        // Collect response headers
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => {
          headers[k] = v;
        });

        return { status: resp.status, headers, body, taint: taintTag() };
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          throw new Error(`Fetch timeout after ${timeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },

    async search() {
      throw new Error('Web search not implemented — use the search provider');
    },
  };
}
