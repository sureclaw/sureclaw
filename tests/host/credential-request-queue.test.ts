// tests/host/credential-request-queue.test.ts
//
// Unit tests for the in-memory credential request queue (Phase 5 Task 5).

import { describe, it, expect } from 'vitest';
import {
  createCredentialRequestQueue,
  type CredentialRequest,
} from '../../src/host/credential-request-queue.js';

function mkReq(overrides: Partial<CredentialRequest> = {}): CredentialRequest {
  return {
    sessionId: 'sess-1',
    envName: 'LINEAR_TOKEN',
    agentName: 'main',
    userId: 'alice',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('createCredentialRequestQueue', () => {
  it('enqueue + snapshot returns the entry', () => {
    const q = createCredentialRequestQueue();
    const req = mkReq();
    q.enqueue(req);
    const snap = q.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toEqual(req);
  });

  it('enqueue duplicate (same sessionId + envName) is a no-op / overwrites', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq({ createdAt: 1 }));
    q.enqueue(mkReq({ createdAt: 2 })); // same key → overwrite
    const snap = q.snapshot();
    expect(snap).toHaveLength(1);
    // The later enqueue's value wins (overwrite semantics).
    expect(snap[0].createdAt).toBe(2);
  });

  it('enqueue different envNames for same sessionId both present', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq({ envName: 'A_TOKEN' }));
    q.enqueue(mkReq({ envName: 'B_TOKEN' }));
    const snap = q.snapshot();
    expect(snap).toHaveLength(2);
    const envs = snap.map((r) => r.envName).sort();
    expect(envs).toEqual(['A_TOKEN', 'B_TOKEN']);
  });

  it('enqueue different sessionIds for same envName both present', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq({ sessionId: 'sess-1' }));
    q.enqueue(mkReq({ sessionId: 'sess-2' }));
    const snap = q.snapshot();
    expect(snap).toHaveLength(2);
    const sessions = snap.map((r) => r.sessionId).sort();
    expect(sessions).toEqual(['sess-1', 'sess-2']);
  });

  it('dequeue matching entry returns 1 and removes it', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq());
    expect(q.snapshot()).toHaveLength(1);

    const removed = q.dequeue('sess-1', 'LINEAR_TOKEN');
    expect(removed).toBe(1);
    expect(q.snapshot()).toEqual([]);
  });

  it('dequeue non-matching entry returns 0', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq());

    // Wrong sessionId
    expect(q.dequeue('other-session', 'LINEAR_TOKEN')).toBe(0);
    // Wrong envName
    expect(q.dequeue('sess-1', 'OTHER_TOKEN')).toBe(0);
    // Both wrong
    expect(q.dequeue('other-session', 'OTHER_TOKEN')).toBe(0);

    // Original entry still there.
    expect(q.snapshot()).toHaveLength(1);
  });

  it('snapshot returns a fresh array (mutations to returned array do not affect queue)', () => {
    const q = createCredentialRequestQueue();
    q.enqueue(mkReq({ envName: 'A_TOKEN' }));

    const snap1 = q.snapshot();
    // Mutate the returned array
    snap1.push(mkReq({ envName: 'EVIL_TOKEN' }));
    // Mutate an entry in the returned array
    snap1[0].envName = 'MUTATED';

    // Next snapshot is untouched — queue has its original entry only.
    const snap2 = q.snapshot();
    expect(snap2).toHaveLength(1);
    expect(snap2[0].envName).toBe('A_TOKEN');
  });
});
