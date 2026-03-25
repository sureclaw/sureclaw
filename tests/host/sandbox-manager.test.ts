import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSandboxSession, createSandboxSession, updateSandboxSession,
  deleteSandboxSession, provisionSandbox, teardownSandbox,
  hasActiveSandbox, reapExpiredSessions,
} from '../../src/host/sandbox-manager.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';
import type { Config } from '../../src/types.js';

// ---------------------------------------------------------------------------
// In-memory DocumentStore
// ---------------------------------------------------------------------------

function memoryDocuments(): DocumentStore {
  const store = new Map<string, Map<string, string>>();
  return {
    async get(collection: string, key: string) {
      return store.get(collection)?.get(key);
    },
    async put(collection: string, key: string, content: string) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, content);
    },
    async delete(collection: string, key: string) {
      return store.get(collection)?.delete(key) ?? false;
    },
    async list(collection: string) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
  };
}

const stubConfig = {} as Config;
const stubSandbox = {} as any;

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

describe('sandbox session CRUD', () => {
  let docs: DocumentStore;

  beforeEach(() => {
    docs = memoryDocuments();
  });

  it('createSandboxSession creates a provisioning session', async () => {
    const session = await createSandboxSession(docs, 'sess-1', 1800);
    expect(session.sessionId).toBe('sess-1');
    expect(session.status).toBe('provisioning');
    expect(session.ttlSeconds).toBe(1800);
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('getSandboxSession retrieves a session', async () => {
    await createSandboxSession(docs, 'sess-2', 600);
    const session = await getSandboxSession(docs, 'sess-2');
    expect(session).not.toBeNull();
    expect(session!.sessionId).toBe('sess-2');
  });

  it('getSandboxSession returns null for non-existent', async () => {
    expect(await getSandboxSession(docs, 'nope')).toBeNull();
  });

  it('getSandboxSession returns null and cleans up expired sessions', async () => {
    // Create a session that's already expired
    await docs.put('sandbox_sessions', 'expired', JSON.stringify({
      sessionId: 'expired',
      podName: 'pod-x',
      podIp: '10.0.0.1',
      status: 'ready',
      approvedAt: new Date(Date.now() - 7200_000).toISOString(),
      ttlSeconds: 1800,
      expiresAt: new Date(Date.now() - 3600_000).toISOString(), // 1 hour ago
    }));

    expect(await getSandboxSession(docs, 'expired')).toBeNull();
    // Verify the expired document was actually deleted from the backing store
    expect(await docs.get('sandbox_sessions', 'expired')).toBeUndefined();
  });

  it('updateSandboxSession updates fields', async () => {
    await createSandboxSession(docs, 'sess-3');
    const updated = await updateSandboxSession(docs, 'sess-3', {
      podName: 'my-pod',
      podIp: '10.0.0.5',
      status: 'ready',
    });

    expect(updated!.podName).toBe('my-pod');
    expect(updated!.status).toBe('ready');
  });

  it('updateSandboxSession returns null for non-existent', async () => {
    expect(await updateSandboxSession(docs, 'nope', { status: 'ready' })).toBeNull();
  });

  it('deleteSandboxSession removes the session', async () => {
    await createSandboxSession(docs, 'sess-del');
    expect(await deleteSandboxSession(docs, 'sess-del')).toBe(true);
    expect(await getSandboxSession(docs, 'sess-del')).toBeNull();
  });

  it('TTL is clamped to min 60, max 3600', async () => {
    const small = await createSandboxSession(docs, 's1', 10);
    expect(small.ttlSeconds).toBe(60);

    const big = await createSandboxSession(docs, 's2', 99999);
    expect(big.ttlSeconds).toBe(3600);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('sandbox lifecycle', () => {
  let docs: DocumentStore;

  beforeEach(() => {
    docs = memoryDocuments();
  });

  it('provisionSandbox creates and marks session as ready', async () => {
    const session = await provisionSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'sess-prov',
      1800,
    );

    expect(session.status).toBe('ready');
    expect(session.podName).toContain('ax-sandbox-');
  });

  it('teardownSandbox removes the session', async () => {
    await provisionSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'sess-tear',
    );

    await teardownSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'sess-tear',
    );

    expect(await getSandboxSession(docs, 'sess-tear')).toBeNull();
  });

  it('teardownSandbox is a no-op for non-existent session', async () => {
    // Should not throw
    await teardownSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'nope',
    );
  });

  it('hasActiveSandbox returns true for ready sessions', async () => {
    await provisionSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'sess-active',
    );

    expect(await hasActiveSandbox(docs, 'sess-active')).toBe(true);
    expect(await hasActiveSandbox(docs, 'nope')).toBe(false);
  });

  it('reapExpiredSessions cleans up expired entries', async () => {
    // Create an expired session directly
    await docs.put('sandbox_sessions', 'old-sess', JSON.stringify({
      sessionId: 'old-sess',
      podName: 'pod-old',
      podIp: '10.0.0.1',
      status: 'ready',
      approvedAt: new Date(Date.now() - 7200_000).toISOString(),
      ttlSeconds: 1800,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // expired
    }));

    // Create a still-valid session
    await provisionSandbox(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
      'new-sess',
      1800,
    );

    const reaped = await reapExpiredSessions(
      { documents: docs, sandbox: stubSandbox, config: stubConfig },
    );

    expect(reaped).toBe(1);
    expect(await getSandboxSession(docs, 'old-sess')).toBeNull();
    expect(await getSandboxSession(docs, 'new-sess')).not.toBeNull();
  });
});
