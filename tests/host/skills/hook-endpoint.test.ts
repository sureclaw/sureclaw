// tests/host/skills/hook-endpoint.test.ts
//
// Unit tests for the HMAC-authenticated reconcile hook HTTP handler.
//
// Covers:
//   - signature missing / malformed / wrong HMAC / wrong length (401)
//   - body too large (413)
//   - Zod validation failures (400) — strict mode rejects extras
//   - happy path (200 + calls reconcileAgent)
//   - reconcileAgent throwing is caught (500, no crash)

import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import {
  createReconcileHookHandler,
  type HookEndpointDeps,
} from '../../../src/host/skills/hook-endpoint.js';

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

function setup(reconcileImpl?: HookEndpointDeps['reconcileAgent']) {
  const reconcileAgent = vi.fn(
    reconcileImpl ?? (async () => ({ skills: 1, events: 2 })),
  );
  const handler = createReconcileHookHandler({ secret: SECRET, reconcileAgent });
  return { reconcileAgent, handler };
}

// ─── tests ───────────────────────────────────────────────────────────────

describe('createReconcileHookHandler — signature verification', () => {
  it('returns 401 when X-AX-Hook-Signature header is missing', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    await handler(fakeReq(body, { 'Content-Type': 'application/json' }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature lacks sha256= prefix', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    await handler(
      fakeReq(body, { 'X-AX-Hook-Signature': 'md5=abc123' }),
      res.res,
    );

    expect(res.getStatus()).toBe(401);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature has wrong length', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const res = fakeRes();
    // valid prefix, hex-ish but too short
    await handler(
      fakeReq(body, { 'X-AX-Hook-Signature': 'sha256=abc123' }),
      res.res,
    );

    expect(res.getStatus()).toBe(401);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when HMAC is wrong but well-formed', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    // 64-char hex, but computed with the wrong secret
    const wrongSig = computeSig(body, 'not-the-secret');
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': wrongSig }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 401 when signature hex contains non-hex characters', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    // 64 chars, but not hex
    const bogus = 'sha256=' + 'z'.repeat(64);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': bogus }), res.res);

    expect(res.getStatus()).toBe(401);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — body validation', () => {
  it('returns 400 when body is missing agentId (valid signature)', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({ ref: 'refs/heads/main', oldSha: '0', newSha: '1' });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(400);
    const payload = JSON.parse(res.getBody());
    expect(payload.error).toBe('Invalid request');
    expect(typeof payload.details).toBe('string');
    expect(payload.details.length).toBeGreaterThan(0);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 400 when body has an extra field (strict mode)', async () => {
    const { handler, reconcileAgent } = setup();
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
    expect(reconcileAgent).not.toHaveBeenCalled();
  });

  it('returns 400 when body is not valid JSON', async () => {
    const { handler, reconcileAgent } = setup();
    const body = 'this is not json';
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(400);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — happy path', () => {
  it('returns 200 with reconcile counts and calls reconcileAgent with agentId + ref', async () => {
    const { handler, reconcileAgent } = setup();
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
    expect(payload).toEqual({ ok: true, skills: 1, events: 2 });
    expect(reconcileAgent).toHaveBeenCalledTimes(1);
    expect(reconcileAgent).toHaveBeenCalledWith('agent-42', 'refs/heads/skills');
  });

  it('uses signature from case-insensitive header lookup', async () => {
    const { handler, reconcileAgent } = setup();
    const body = JSON.stringify({
      agentId: 'agent-1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    // fakeReq already lowercases, which is what Node does in real headers
    await handler(fakeReq(body, { 'x-ax-hook-signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(reconcileAgent).toHaveBeenCalledTimes(1);
  });
});

describe('createReconcileHookHandler — body size limit', () => {
  it('returns 413 when body exceeds 64 KiB and does NOT call reconcileAgent', async () => {
    const { handler, reconcileAgent } = setup();
    // 65 KiB payload — bigger than the 64 KiB cap
    const big = 'x'.repeat(65 * 1024);
    const body = JSON.stringify({
      agentId: 'a1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
      pad: big,
    });
    // signature is irrelevant — we shouldn't even get to verification
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(413);
    expect(reconcileAgent).not.toHaveBeenCalled();
  });
});

describe('createReconcileHookHandler — byte-exact HMAC', () => {
  it('verifies HMAC over raw bytes without utf-8 normalization', async () => {
    // Valid JSON with a stray invalid utf-8 byte (0xC3 alone — not a full
    // multi-byte sequence). If the handler .toString('utf-8')'s the body
    // before HMAC, it replaces 0xC3 with U+FFFD (0xEF 0xBF 0xBD) and the
    // HMAC over normalized bytes will NOT match the HMAC over raw bytes.
    // The shell client signs raw bytes, so the handler must too.
    const jsonPart = Buffer.from(
      JSON.stringify({ agentId: 'a1', ref: 'refs/heads/main', oldSha: '0', newSha: '1' }),
      'utf-8',
    );
    // Splice an invalid utf-8 byte into a string field. Keep the JSON
    // well-formed enough to verify behavior — we only care about the HMAC
    // path here. We append a prefix comment? No — we need valid JSON for
    // the 200 response path. Use a raw byte AFTER the JSON body that gets
    // included in the signed bytes. Simpler: include a raw byte inside a
    // string value via Buffer concat.
    const rawBytes = Buffer.concat([
      Buffer.from(
        '{"agentId":"a1","ref":"refs/heads/main","oldSha":"',
        'utf-8',
      ),
      Buffer.from([0xc3]), // stray invalid utf-8 byte
      Buffer.from('","newSha":"1"}', 'utf-8'),
    ]);

    // Sign the exact bytes, like the shell hook would.
    const sig = computeSig(rawBytes, SECRET);

    // If the handler did .toString('utf-8') before HMAC, 0xc3 would become
    // U+FFFD (0xef 0xbf 0xbd) and the HMAC would not match — 401.
    // With Buffer-based HMAC we expect the signature to verify.
    // The body parses as JSON (oldSha ends up containing the replacement
    // char after JSON.parse, which is fine — we only verify signature +
    // schema passes here). Zod doesn't constrain oldSha's charset.
    const { handler, reconcileAgent } = setup();
    const res = fakeRes();
    await handler(fakeReqFromBuffer(rawBytes, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(200);
    expect(reconcileAgent).toHaveBeenCalledTimes(1);
    // Touch jsonPart so the import isn't dead code — kept for doc clarity.
    expect(jsonPart.length).toBeGreaterThan(0);
  });
});

describe('createReconcileHookHandler — reconcileAgent failure', () => {
  it('returns 500 when reconcileAgent throws and does not crash the handler', async () => {
    const { handler, reconcileAgent } = setup(async () => {
      throw new Error('boom');
    });
    const body = JSON.stringify({
      agentId: 'a1',
      ref: 'refs/heads/main',
      oldSha: '0',
      newSha: '1',
    });
    const sig = computeSig(body, SECRET);
    const res = fakeRes();
    await handler(fakeReq(body, { 'X-AX-Hook-Signature': sig }), res.res);

    expect(res.getStatus()).toBe(500);
    expect(reconcileAgent).toHaveBeenCalledTimes(1);
  });
});
