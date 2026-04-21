// tests/host/skills/hook-endpoint.test.ts
//
// Unit tests for the HMAC-authenticated post-receive hook HTTP handler.
//
// Covers:
//   - signature missing / malformed / wrong HMAC / wrong length (401)
//   - body too large (413)
//   - Zod validation failures (400) — strict mode rejects extras
//   - happy path (200 + calls snapshotCache.invalidateAgent)

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  createReconcileHookHandler,
  type HookEndpointDeps,
} from '../../../src/host/skills/hook-endpoint.js';
import type { SnapshotCache } from '../../../src/host/skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';
import {
  getOrBuildCatalog,
  invalidateAllCatalogs,
  catalogCacheSize,
} from '../../../src/host/tool-catalog/cache.js';
import type { CatalogTool } from '../../../src/types/catalog.js';

// ─── fake req / res ──────────────────────────────────────────────────────

function fakeReq(body: string, headers: Record<string, string>): IncomingMessage {
  const readable = Readable.from([Buffer.from(body, 'utf-8')]);
  const req = readable as unknown as IncomingMessage;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  req.method = 'POST';
  req.url = '/v1/internal/skills/reconcile';
  return req;
}

interface FakeRes {
  res: ServerResponse;
  getStatus(): number;
  getBody(): string;
  getHeaders(): Record<string, string | number>;
}

function fakeRes(): FakeRes {
  const chunks: Buffer[] = [];
  let status = 0;
  let headers: Record<string, string | number> = {};
  const res = {
    writeHead(s: number, h?: Record<string, string | number>) {
      status = s;
      if (h) headers = h;
      return res;
    },
    setHeader(name: string, value: string | number) {
      headers[name] = value;
    },
    end(chunk?: Buffer | string) {
      if (chunk) chunks.push(Buffer.from(chunk as any));
    },
    write(chunk: Buffer | string) {
      chunks.push(Buffer.from(chunk as any));
      return true;
    },
  } as unknown as ServerResponse;
  return {
    res,
    getStatus: () => status,
    getBody: () => Buffer.concat(chunks).toString('utf-8'),
    getHeaders: () => headers,
  };
}

// ─── signature helper ────────────────────────────────────────────────────

function computeSig(body: string | Buffer, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

function fakeReqFromBuffer(body: Buffer, headers: Record<string, string>): IncomingMessage {
  const readable = Readable.from([body]);
  const req = readable as unknown as IncomingMessage;
  req.headers = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  req.method = 'POST';
  req.url = '/v1/internal/skills/reconcile';
  return req;
}

// ─── test-level setup ────────────────────────────────────────────────────

const SECRET = 'test-secret';

function mockSnapshotCache(invalidateImpl?: (agentId: string) => number): {
  snapshotCache: SnapshotCache<SkillSnapshotEntry[]>;
  invalidateAgent: ReturnType<typeof vi.fn>;
} {
  const invalidateAgent = vi.fn(invalidateImpl ?? (() => 0));
  const snapshotCache = {
    get: vi.fn(),
    put: vi.fn(),
    invalidateAgent,
    clear: vi.fn(),
    size: vi.fn().mockReturnValue(0),
  } as unknown as SnapshotCache<SkillSnapshotEntry[]>;
  return { snapshotCache, invalidateAgent };
}

function setup(
  invalidateImpl?: (agentId: string) => number,
): {
  handler: ReturnType<typeof createReconcileHookHandler>;
  invalidateAgent: ReturnType<typeof vi.fn>;
} {
  const { snapshotCache, invalidateAgent } = mockSnapshotCache(invalidateImpl);
  const deps: HookEndpointDeps = { secret: SECRET, snapshotCache };
  const handler = createReconcileHookHandler(deps);
  return { handler, invalidateAgent };
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('createReconcileHookHandler — signature verification', () => {
  it('returns 401 when X-AX-Hook-Signature header is missing', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    await handler(fakeReq(body, { 'Content-Type': 'application/json' }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature lacks sha256= prefix', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    await handler(
      fakeReq(body, { 'X-AX-Hook-Signature': 'md5=abc123' }),
      res.res,
    );

    expect(res.getStatus()).toBe(401);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature has wrong length', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    await handler(
      fakeReq(body, { 'X-AX-Hook-Signature': 'sha256=abc123' }),
      res.res,
    );

    expect(res.getStatus()).toBe(401);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when HMAC is wrong but well-formed', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const wrongSig = computeSig(body, 'not-the-secret');
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': wrongSig }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature hex contains non-hex characters', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const bogus = 'sha256=' + 'z'.repeat(64);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': bogus }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — body validation', () => {
  it('returns 400 when body is missing agentId (valid signature)', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({ ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(400);
    const payload = JSON.parse(res.getBody());
    expect(payload.error).toBe('Invalid request');
    expect(typeof payload.details).toBe('string');
    expect(payload.details.length).toBeGreaterThan(0);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 400 when body has an extra field (strict mode)', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({
      agentId: 'a1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
      extra: 'not allowed',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(400);
    const payload = JSON.parse(res.getBody());
    expect(payload.error).toBe('Invalid request');
    expect(invalidateAgent).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const { handler, invalidateAgent } = setup();
    const body = 'this is not json';
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(400);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — happy path', () => {
  it('returns 200 with invalidated count and calls invalidateAgent for the agentId', async () => {
    const { handler, invalidateAgent } = setup(() => 3);
    const body = JSON.stringify({
      agentId: 'agent-42',
      ref: 'refs/heads/skills',
      oldSha: 'aaaaaaaa',
      newSha: 'bbbbbbbb',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    const payload = JSON.parse(res.getBody());
    expect(payload).toEqual({ ok: true, invalidated: 3 });
    expect(invalidateAgent).toHaveBeenCalledTimes(1);
    expect(invalidateAgent).toHaveBeenCalledWith('agent-42');
  });

  it('also invalidates the tool-catalog cache for the agent', async () => {
    // Pre-load the module-scoped catalog cache with an entry for the agent
    // the hook is about to target, plus one for a different agent. After
    // the hook fires, the targeted agent's entries should be gone and the
    // bystander agent's entry should remain.
    invalidateAllCatalogs();
    const sampleTool: CatalogTool = {
      name: 'mcp_sample',
      skill: 's',
      summary: 's',
      schema: { type: 'object' },
      dispatch: { kind: 'mcp', server: 's', toolName: 'sample' },
    };
    await getOrBuildCatalog({
      agentId: 'agent-42',
      userId: 'u1',
      headSha: 'sha-old',
      build: async () => [sampleTool],
    });
    await getOrBuildCatalog({
      agentId: 'bystander',
      userId: 'u1',
      headSha: 'sha-old',
      build: async () => [sampleTool],
    });
    expect(catalogCacheSize()).toBe(2);

    const { handler } = setup(() => 0);
    const body = JSON.stringify({
      agentId: 'agent-42',
      ref: 'refs/heads/skills',
      oldSha: 'aa',
      newSha: 'bb',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    // agent-42 gone, bystander untouched.
    expect(catalogCacheSize()).toBe(1);
    // Clean up so later tests don't see leftover entries.
    invalidateAllCatalogs();
  });

  it('returns 200 with invalidated: 0 when the agent has no cached entries', async () => {
    const { handler, invalidateAgent } = setup();
    const body = JSON.stringify({
      agentId: 'cold-agent',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(JSON.parse(res.getBody())).toEqual({ ok: true, invalidated: 0 });
    expect(invalidateAgent).toHaveBeenCalledTimes(1);
  });

  it('uses signature from case-insensitive header lookup', async () => {
    const { handler, invalidateAgent } = setup(() => 1);
    const body = JSON.stringify({
      agentId: 'agent-1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'x-ax-hook-signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(invalidateAgent).toHaveBeenCalledTimes(1);
  });
});

describe('createReconcileHookHandler — orphan sweep', () => {
  it('runs sweepOrphanedRows after cache invalidation when agentSkillsDeps is wired', async () => {
    // Regression: the "delete skill in turn N, re-add in turn N+1" race
    // where the orphan sweep at turn-start `loadSnapshot` runs too late
    // (credential already matches the re-added skill). Running sweep in
    // the hook (after every push) closes the window.
    const { snapshotCache } = mockSnapshotCache();

    // Stub agentSkillsDeps returning a snapshot that's MISSING linear
    // but credential rows STILL reference it → orphan sweep should delete.
    const credDeleteSpy = vi.fn(async () => {});
    const domainDeleteSpy = vi.fn(async () => {});
    const agentSkillsDeps = {
      skillCredStore: {
        put: vi.fn(),
        get: vi.fn(),
        listForAgent: vi.fn(async () => [
          { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'u', value: 'v' },
        ]),
        listEnvNames: vi.fn(),
        deleteForSkill: credDeleteSpy,
      },
      skillDomainStore: {
        approve: vi.fn(),
        listForAgent: vi.fn(async () => []),
        deleteForSkill: domainDeleteSpy,
      },
      getBareRepoPath: async () => '/unused',
      probeHead: async () => 'sha-after-delete',
      snapshotCache: {
        ...snapshotCache,
        get: vi.fn(() => []), // empty snapshot — linear was just deleted
      } as any,
    };

    const handler = createReconcileHookHandler({
      secret: SECRET,
      snapshotCache,
      agentSkillsDeps: agentSkillsDeps as any,
    });

    const body = JSON.stringify({
      agentId: 'ax',
      ref: 'refs/heads/main',
      oldSha: 'aaaa',
      newSha: 'bbbb',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(credDeleteSpy).toHaveBeenCalledWith('ax', 'linear');
    expect(domainDeleteSpy).toHaveBeenCalledWith('ax', 'linear');
  });

  it('still returns 200 even if sweep throws (sweep failure must not break pushes)', async () => {
    const { snapshotCache } = mockSnapshotCache();
    const failingDeps = {
      skillCredStore: {
        put: vi.fn(),
        get: vi.fn(),
        listForAgent: vi.fn(async () => { throw new Error('db down'); }),
        listEnvNames: vi.fn(),
        deleteForSkill: vi.fn(),
      },
      skillDomainStore: {
        approve: vi.fn(),
        listForAgent: vi.fn(async () => []),
        deleteForSkill: vi.fn(),
      },
      getBareRepoPath: async () => '/unused',
      probeHead: async () => 'sha',
      snapshotCache: {
        ...snapshotCache,
        get: vi.fn(() => []),
      } as any,
    };

    const handler = createReconcileHookHandler({
      secret: SECRET,
      snapshotCache,
      agentSkillsDeps: failingDeps as any,
    });

    const body = JSON.stringify({
      agentId: 'ax',
      ref: 'refs/heads/main',
      oldSha: 'aaaa',
      newSha: 'bbbb',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
  });
});

describe('createReconcileHookHandler — body size limit', () => {
  it('returns 413 when body exceeds 64 KiB and does NOT call invalidateAgent', async () => {
    const { handler, invalidateAgent } = setup();
    const big = 'x'.repeat(65 * 1024);
    const body = JSON.stringify({
      agentId: 'a1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
      pad: big,
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(413);
    expect(invalidateAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — byte-exact HMAC', () => {
  it('verifies HMAC over raw bytes without utf-8 normalization', async () => {
    // Valid JSON body with a stray invalid utf-8 byte (0xC3 alone — not a
    // full multi-byte sequence). The shell client signs raw bytes, so the
    // handler must HMAC over the raw Buffer, not a utf-8-normalized string.
    const rawBytes = Buffer.concat([
      Buffer.from(
        '{"agentId":"a1","ref":"refs/heads/main","oldSha":"',
        'utf-8',
      ),
      Buffer.from([0xc3]), // stray invalid utf-8 byte
      Buffer.from('","newSha":"1"}', 'utf-8'),
    ]);

    const sig = computeSig(rawBytes, SECRET);
    const { handler, invalidateAgent } = setup();
    const res = fakeRes();
    await handler(fakeReqFromBuffer(rawBytes, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(invalidateAgent).toHaveBeenCalledTimes(1);
  });
});
