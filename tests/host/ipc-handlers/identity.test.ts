import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdentityHandlers } from '../../../src/host/ipc-handlers/identity.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';

let tmpDir: string;
let agentTopDirPath: string;

vi.mock('../../../src/paths.js', () => ({
  agentDir: () => agentTopDirPath,
}));

vi.mock('../../../src/host/server.js', async () => {
  const { existsSync: ex, readFileSync: rf } = await import('node:fs');
  const { join: j } = await import('node:path');
  return {
    isAgentBootstrapMode: () => false,
    isAdmin: (dir: string, userId: string) => {
      const adminsPath = j(dir, 'admins');
      if (!ex(adminsPath)) return false;
      const lines = rf(adminsPath, 'utf-8').split('\n').map((l: string) => l.trim()).filter(Boolean);
      return lines.includes(userId);
    },
  };
});

/** In-memory DocumentStore for testing. */
function createMockDocumentStore(): DocumentStore {
  const store = new Map<string, Map<string, string>>();

  function getCollection(collection: string): Map<string, string> {
    let col = store.get(collection);
    if (!col) {
      col = new Map();
      store.set(collection, col);
    }
    return col;
  }

  return {
    async get(collection: string, key: string): Promise<string | undefined> {
      return getCollection(collection).get(key);
    },
    async put(collection: string, key: string, content: string): Promise<void> {
      getCollection(collection).set(key, content);
    },
    async delete(collection: string, key: string): Promise<boolean> {
      return getCollection(collection).delete(key);
    },
    async list(collection: string): Promise<string[]> {
      return [...getCollection(collection).keys()];
    },
  };
}

function stubProviders(documents?: DocumentStore): ProviderRegistry {
  const docs = documents ?? createMockDocumentStore();
  return {
    audit: { log: vi.fn() },
    security: { scanInput: vi.fn().mockResolvedValue({ verdict: 'PASS' }) },
    storage: {
      documents: docs,
      messages: {} as any,
      conversations: {} as any,
      sessions: {} as any,
      close: vi.fn(),
    },
  } as any;
}

describe('Identity IPC handlers', () => {
  let ctx: IPCContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-id-test-'));
    agentTopDirPath = join(tmpDir, 'top');
    mkdirSync(agentTopDirPath, { recursive: true });

    ctx = { sessionId: 'sess-1', agentId: 'main', userId: 'alice' };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── identity_read ──

  test('identity_read returns file content when document exists', async () => {
    const documents = createMockDocumentStore();
    await documents.put('identity', 'main/SOUL.md', '# My Soul');
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_read({ file: 'SOUL.md' }, ctx);

    expect(result.content).toBe('# My Soul');
    expect(result.file).toBe('SOUL.md');
  });

  test('identity_read returns empty string for missing document', async () => {
    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_read({ file: 'IDENTITY.md' }, ctx);

    expect(result.content).toBe('');
    expect(result.file).toBe('IDENTITY.md');
  });

  // ── identity_write admin gate ──

  test('identity_write rejects non-admin users', async () => {
    // Create admins file WITHOUT alice
    writeFileSync(join(agentTopDirPath, 'admins'), 'bob\n', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: 'hacked', reason: 'test', origin: 'user_request' },
      ctx,
    );

    expect(result.queued).toBe(true);
    expect(result.reason).toContain('Non-admin');
    // Document should NOT be written
    const stored = await documents.get('identity', 'main/SOUL.md');
    expect(stored).toBeUndefined();
  });

  test('identity_write allows admin users', async () => {
    // Create admins file WITH alice
    writeFileSync(join(agentTopDirPath, 'admins'), 'alice\n', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: '# My Soul', reason: 'test', origin: 'user_request' },
      ctx,
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/SOUL.md');
    expect(stored).toBe('# My Soul');
  });

  test('identity_write allows when admins file is empty (k8s agent-runtime)', async () => {
    // In k8s, the agent-runtime pod creates an empty admins file at startup.
    // Admin claims happen on the host pod (separate filesystem).
    // The admin gate should be skipped when no admins are configured.
    writeFileSync(join(agentTopDirPath, 'admins'), '', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: '# My Soul', reason: 'bootstrap', origin: 'user_request' },
      ctx,
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/SOUL.md');
    expect(stored).toBe('# My Soul');
  });

  test('identity_write allows when no admins file exists (fresh install)', async () => {
    // No admins file at all — should allow writes (bootstrap scenario)
    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'IDENTITY.md', content: '# My Identity', reason: 'bootstrap', origin: 'user_request' },
      ctx,
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/IDENTITY.md');
    expect(stored).toBe('# My Identity');
  });

  test('identity_write allows when no userId (system context)', async () => {
    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    // Context without userId
    const systemCtx: IPCContext = { sessionId: 'sess-1', agentId: 'system' };

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: '# System Soul', reason: 'test', origin: 'user_request' },
      systemCtx,
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/SOUL.md');
    expect(stored).toBe('# System Soul');
  });

  // ── user_write admin gate ──

  test('user_write rejects non-admin writing another user file', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), 'bob\n', 'utf-8');

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'bob', content: 'hacked', reason: 'test', origin: 'user_request' },
      ctx, // alice trying to write bob's file
    );

    expect(result.queued).toBe(true);
    expect(result.reason).toContain('Non-admin');
  });

  test('user_write allows non-admin writing their own user file', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), 'bob\n', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'alice', content: '# Alice prefs', reason: 'test', origin: 'user_request' },
      ctx, // alice writing alice's file — allowed
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/users/alice/USER.md');
    expect(stored).toBe('# Alice prefs');
  });

  test('user_write allows writing other user file when admins file is empty (k8s)', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), '', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'bob', content: '# Bob prefs', reason: 'test', origin: 'user_request' },
      ctx, // alice writing bob's file — allowed because no admins configured
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/users/bob/USER.md');
    expect(stored).toBe('# Bob prefs');
  });

  test('user_write allows admin writing another user file', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), 'alice\n', 'utf-8');

    const documents = createMockDocumentStore();
    const providers = stubProviders(documents);
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'bob', content: '# Bob prefs', reason: 'admin edit', origin: 'user_request' },
      ctx, // alice (admin) writing bob's file — allowed
    );

    expect(result.applied).toBe(true);
    const stored = await documents.get('identity', 'main/users/bob/USER.md');
    expect(stored).toBe('# Bob prefs');
  });
});
