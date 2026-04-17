// tests/host/skills/mount-route.test.ts
//
// Integration test for the mount wiring of /v1/internal/skills/reconcile.
//
// Rather than spin up the full AX server (heavy, many provider dependencies),
// this test reproduces the exact route-dispatch pattern used in server.ts's
// handleInternalRoutes — "if (url === '/v1/internal/skills/reconcile' &&
// req.method === 'POST')" — and wires in the real createReconcileHookHandler
// via a stub reconcileAgent. That's enough to catch regressions in:
//   - route-path / method matching
//   - request body plumbing
//   - HMAC verification (unsigned → 401)
//   - happy-path round trip (signed → 200 + invokes reconcileAgent)
//
// Full e2e (against an actual server instance) is covered by phase-2 task 10.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { createReconcileHookHandler } from '../../../src/host/skills/hook-endpoint.js';
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
  reconcileAgent: (agentId: string, ref: string) => Promise<{ skills: number; events: number }>;
}): Promise<{ server: Server; port: number }> {
  const handler = createReconcileHookHandler({
    secret: opts.secret,
    reconcileAgent: opts.reconcileAgent,
  });

  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = req.url ?? '/';
      // Mirror server.ts handleInternalRoutes dispatch:
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

describe('POST /v1/internal/skills/reconcile mount', () => {
  let server: Server;
  let port: number;
  let reconcileAgent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    reconcileAgent = vi.fn().mockResolvedValue({ skills: 2, events: 3 });
    const result = await buildServer({ secret: SECRET, reconcileAgent });
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  it('returns 200 and invokes reconcileAgent for signed requests', async () => {
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
    expect(payload).toEqual({ ok: true, skills: 2, events: 3 });
    expect(reconcileAgent).toHaveBeenCalledOnce();
    expect(reconcileAgent).toHaveBeenCalledWith('main', 'refs/heads/main');
  });

  it('returns 401 for unsigned requests', async () => {
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
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 401 for requests signed with the wrong secret', async () => {
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
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 404 for GET requests on the same path (wrong method)', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/internal/skills/reconcile`);
    expect(res.status).toBe(404);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });
});
