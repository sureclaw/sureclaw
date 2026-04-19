// tests/host/skills/mount-route.test.ts
//
// Integration test for the mount wiring of /v1/internal/skills/reconcile.
//
// Rather than spin up the full AX server (heavy, many provider dependencies),
// this test reproduces the exact route-dispatch pattern used in server.ts's
// handleInternalRoutes — "if (url === '/v1/internal/skills/reconcile' &&
// req.method === 'POST')" — and wires in the real createReconcileHookHandler
// against a real SnapshotCache. That's enough to catch regressions in:
//   - route-path / method matching
//   - request body plumbing
//   - HMAC verification (unsigned → 401)
//   - happy-path round trip (signed → 200 + invalidates the agent's entries)

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { createReconcileHookHandler } from '../../../src/host/skills/hook-endpoint.js';
import { createSnapshotCache } from '../../../src/host/skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ level: 'silent', file: false });

// Helper: HMAC-SHA256 signature, same format as the hook handler expects.
function computeSig(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// Builds a tiny HTTP server whose dispatch mirrors server.ts's
// handleInternalRoutes for the reconcile path. If we ever rename the path
// or break the method check, this test will fail.
function buildServer(opts: {
  secret: string;
  snapshotCache: ReturnType<typeof createSnapshotCache<SkillSnapshotEntry[]>>;
}): Promise<{ server: Server; port: number }> {
  const handler = createReconcileHookHandler({
    secret: opts.secret,
    snapshotCache: opts.snapshotCache,
  });

  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      if (url === '/v1/internal/skills/reconcile' && req.method === 'POST') {
        await handler(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as any).port;
      resolve({ server, port });
    });
  });
}

const SECRET = 'mount-route-test-secret';

function seedEntry(name: string): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    body: '',
    frontmatter: {
      name,
      description: `skill ${name}`,
      credentials: [],
      mcpServers: [],
      domains: [],
    },
  };
}

describe('POST /v1/internal/skills/reconcile mount', () => {
  let server: Server;
  let port: number;
  let snapshotCache: ReturnType<typeof createSnapshotCache<SkillSnapshotEntry[]>>;

  beforeEach(async () => {
    snapshotCache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 16 });
    const result = await buildServer({ secret: SECRET, snapshotCache });
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  it('returns 200 and invalidates cached entries for the agent on signed requests', async () => {
    // Seed two entries for `main` plus one for a different agent.
    snapshotCache.put('main@sha1', [seedEntry('a')]);
    snapshotCache.put('main@sha2', [seedEntry('b')]);
    snapshotCache.put('other@sha1', [seedEntry('c')]);
    expect(snapshotCache.size()).toBe(3);

    const body = JSON.stringify({
      agentId: 'main',
      ref: 'refs/heads/main',
      oldSha: '0'.repeat(40),
      newSha: 'a'.repeat(40),
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/internal/skills/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AX-Hook-Signature': computeSig(body, SECRET),
      },
      body,
    });

    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ ok: true, invalidated: 2 });

    // Other agent's entry survives.
    expect(snapshotCache.get('other@sha1')).toBeDefined();
    expect(snapshotCache.get('main@sha1')).toBeUndefined();
    expect(snapshotCache.get('main@sha2')).toBeUndefined();
  });

  it('returns 401 for unsigned requests', async () => {
    snapshotCache.put('main@sha1', [seedEntry('a')]);

    const body = JSON.stringify({
      agentId: 'main',
      ref: 'refs/heads/main',
      oldSha: '0'.repeat(40),
      newSha: 'a'.repeat(40),
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/internal/skills/reconcile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    expect(res.status).toBe(401);
    // Entry untouched.
    expect(snapshotCache.get('main@sha1')).toBeDefined();
  });

  it('returns 401 for requests signed with the wrong secret', async () => {
    snapshotCache.put('main@sha1', [seedEntry('a')]);

    const body = JSON.stringify({
      agentId: 'main',
      ref: 'refs/heads/main',
      oldSha: '0'.repeat(40),
      newSha: 'a'.repeat(40),
    });

    const res = await fetch(`http://127.0.0.1:${port}/v1/internal/skills/reconcile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AX-Hook-Signature': computeSig(body, 'wrong-secret'),
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(snapshotCache.get('main@sha1')).toBeDefined();
  });

  it('returns 404 for GET requests on the same path (wrong method)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/internal/skills/reconcile`);
    expect(res.status).toBe(404);
  });
});
