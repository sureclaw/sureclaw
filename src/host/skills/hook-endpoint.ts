// src/host/skills/hook-endpoint.ts — HMAC-authenticated HTTP handler for
// the post-receive hook.
//
// The per-agent git post-receive hook POSTs a small JSON body to the host
// whenever a ref moves. Because the push pipeline is local (unix socket or
// git-http in-cluster) but still flows over HTTP, we authenticate each call
// with an HMAC-SHA256 of the raw body, using a shared secret.
//
// Responsibilities:
//   1. Read the raw body (cap 64 KiB → 413 above that).
//   2. Verify `X-AX-Hook-Signature: sha256=<hex>` against sha256-HMAC of the
//      raw bytes, in constant time. Missing / malformed / wrong → 401.
//   3. Parse + Zod-strict-validate the JSON body. Failure → 400.
//   4. Invalidate the agent's snapshot-cache entries so the next live read
//      (`getAgentSkills` / `getAgentSetupQueue`) walks git afresh.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getLogger } from '../../logger.js';
import type { SnapshotCache } from './snapshot-cache.js';
import type { SkillSnapshotEntry } from './types.js';
import type { GetAgentSkillsDeps } from './get-agent-skills.js';
import { loadSnapshot, sweepOrphanedRows } from './get-agent-skills.js';
import { invalidateCatalog } from '../tool-catalog/cache.js';

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
  /** Snapshot cache used by `getAgentSkills`. The handler drops every entry
   *  whose key starts with `${agentId}@` after signature + schema pass. */
  snapshotCache: SnapshotCache<SkillSnapshotEntry[]>;
  /** Full `agentSkillsDeps` so the hook can sweep orphaned rows immediately
   *  after a push lands. Without this, a sequence of agent turns that
   *  delete then re-add a skill within one session never triggers the
   *  sweep (which normally runs at turn-start `loadSnapshot`), and the
   *  re-added skill auto-enables from a stale credential row. Optional
   *  so setups without a database still get the cache-bust behaviour. */
  agentSkillsDeps?: GetAgentSkillsDeps;
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

    // 4. Invalidate the agent's cached snapshots. Next read walks git again.
    //    Also drop the per-turn catalog cache — its key includes HEAD-sha, and
    //    a push is the canonical HEAD-change event. Without this, the next
    //    turn at the new HEAD would still hit the cache (key miss on the new
    //    sha), so stale entries accumulate until the process exits; small
    //    leak, but cheap to do right.
    const { agentId } = validation.data;
    const dropped = deps.snapshotCache.invalidateAgent(agentId);
    const catalogDropped = invalidateCatalog(agentId);
    log.debug('hook_cache_invalidated', { agentId, dropped, catalogDropped });

    // 5. Run the orphan sweep against the FRESH snapshot. Catches the
    //    "delete skill in turn N, re-add in turn N+1" race: without this,
    //    sweep runs via `loadSnapshot` only at turn-start, which may see
    //    a snapshot where the skill is already back (because both commits
    //    landed between the two getAgentSkills calls), letting the stale
    //    credential row auto-enable the re-added skill. Running here, right
    //    after each push, means the moment the skill disappears from git,
    //    its rows are cleaned — a later re-add sees an empty projection
    //    and correctly surfaces a setup card.
    if (deps.agentSkillsDeps) {
      try {
        const fresh = await loadSnapshot(agentId, deps.agentSkillsDeps);
        const swept = await sweepOrphanedRows(agentId, fresh, deps.agentSkillsDeps);
        if (swept.length > 0) {
          log.info('hook_orphan_sweep', { agentId, sweptSkills: swept });
        }
      } catch (err) {
        // Sweep failures shouldn't fail the push — log and continue.
        log.warn('hook_orphan_sweep_failed', {
          agentId,
          error: (err as Error).message,
        });
      }
    }

    sendJson(res, 200, { ok: true, invalidated: dropped });
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
