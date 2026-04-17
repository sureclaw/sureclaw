// src/host/skills/hook-endpoint.ts — HMAC-authenticated HTTP handler for
// the post-receive reconcile hook.
//
// The git push hook (installed per-agent) POSTs a small JSON body to the host
// whenever a ref moves. Because the push pipeline is local (unix socket or
// git-http in-cluster) but still flows over HTTP, we authenticate each call
// with an HMAC-SHA256 of the raw body, using a shared secret. mTLS would be
// overkill for phase 2 — rotating an env var is easier than rotating certs.
//
// Responsibilities:
//   1. Read the raw body (cap 64 KiB → 413 above that).
//   2. Verify `X-AX-Hook-Signature: sha256=<hex>` against sha256-HMAC of the
//      raw bytes, in constant time. Missing / malformed / wrong → 401.
//   3. Parse + Zod-strict-validate the JSON body. Failure → 400.
//   4. `await reconcileAgent(agentId, ref)`. Throw → 500 (logged, but the
//      server keeps running).
//
// Only the factory is exported. Task 6 mounts this onto the real router.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getLogger } from '../../logger.js';

/** Max request body size for the hook endpoint. A real post-receive payload
 *  is ~200 bytes; 64 KiB is a paranoid DoS cap. */
const MAX_BODY_BYTES = 64 * 1024;

const BodySchema = z
  .object({
    agentId: z.string().min(1),
    ref: z.string().min(1),
    oldSha: z.string(),
    newSha: z.string(),
  })
  .strict();

export interface HookEndpointDeps {
  /** Shared secret used on both sides of the HMAC. */
  secret: string;
  /** Orchestrator entry point. Task 4 already catches internally, but we
   *  wrap the await with try/catch here too — the server process must not
   *  die on a bad reconcile. */
  reconcileAgent: (agentId: string, ref: string) => Promise<{ skills: number; events: number }>;
}

export function createReconcileHookHandler(
  deps: HookEndpointDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = getLogger().child({ component: 'skills-hook-endpoint' });

  return async function handleReconcileHook(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    // 1. Read raw body with 64 KiB cap. Keep as Buffer so the HMAC covers
    //    exact bytes — a utf-8 round-trip would replace any invalid byte
    //    sequences with U+FFFD, which the shell client's openssl sign doesn't
    //    do, producing spurious 401s.
    let raw: Buffer;
    try {
      raw = await readRawBody(req, MAX_BODY_BYTES);
    } catch (err) {
      if ((err as Error).message === 'TOO_LARGE') {
        sendError(res, 413, 'Payload too large');
        return;
      }
      log.warn('hook_body_read_failed', { error: (err as Error).message });
      sendError(res, 400, 'Invalid request');
      return;
    }

    // 2. Verify HMAC signature against raw bytes (byte-exact, not parsed).
    const sigHeader = req.headers['x-ax-hook-signature'];
    const headerValue = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    if (!verifySignature(raw, headerValue, deps.secret)) {
      sendError(res, 401, 'Unauthorized');
      return;
    }

    // 3. Parse + validate body. Do this AFTER signature verification so
    //    attackers can't probe for Zod error differences.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf-8'));
    } catch {
      sendErrorWithDetails(res, 400, 'Invalid request', 'Body is not valid JSON');
      return;
    }
    const validation = BodySchema.safeParse(parsed);
    if (!validation.success) {
      sendErrorWithDetails(res, 400, 'Invalid request', validation.error.message);
      return;
    }

    // 4. Run the reconcile. Any throw becomes a 500 — the orchestrator
    //    already catches internally (phase-2 design), but belt and braces.
    const { agentId, ref } = validation.data;
    let result: { skills: number; events: number };
    try {
      result = await deps.reconcileAgent(agentId, ref);
    } catch (err) {
      log.error('reconcile_hook_failed', {
        agentId,
        ref,
        error: (err as Error).message,
      });
      sendError(res, 500, 'Reconcile failed');
      return;
    }

    sendJson(res, 200, { ok: true, skills: result.skills, events: result.events });
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Read the raw request body as a Buffer, capped at `maxBytes`. Throws an
 *  Error with message `TOO_LARGE` if the cap is exceeded. Returning Buffer
 *  (not string) is deliberate: the HMAC must be computed over the exact
 *  bytes the shell client signed, with no utf-8 replacement-character
 *  round-trip. */
async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const done = (err: Error | null, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(value!);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        // Stop reading and fail fast.
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        done(new Error('TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => done(null, Buffer.concat(chunks)));
    req.on('error', (err) => done(err));
  });
}

/** Constant-time signature verification. Returns false for missing headers,
 *  wrong prefix, wrong hex length, non-hex characters, or wrong HMAC.
 *  Takes the raw body as a Buffer so the HMAC is computed over the exact
 *  bytes the hook client signed. */
function verifySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  if (!header || !header.startsWith('sha256=')) return false;
  const received = header.slice('sha256='.length);
  // Length + hex gate. timingSafeEqual throws on unequal-length buffers,
  // so we MUST check this first.
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac('sha256', secret).update(raw).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(received, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function sendErrorWithDetails(
  res: ServerResponse,
  status: number,
  message: string,
  details: string,
): void {
  sendJson(res, status, { error: message, details });
}
