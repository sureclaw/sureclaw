import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin, type AdminContext } from '../../src/host/server-admin-helpers.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import type { DocumentStore } from '../../src/providers/storage/types.js';

/** In-memory DocumentStore for testing. */
function createMemoryDocumentStore(): DocumentStore {
  const store = new Map<string, string>();
  return {
    async get(collection: string, key: string) {
      return store.get(`${collection}:${key}`);
    },
    async put(collection: string, key: string, content: string) {
      store.set(`${collection}:${key}`, content);
    },
    async delete(collection: string, key: string) {
      return store.delete(`${collection}:${key}`);
    },
    async list(collection: string) {
      return [...store.keys()]
        .filter(k => k.startsWith(`${collection}:`))
        .map(k => k.slice(collection.length + 1));
    },
  };
}

// ── Unit tests for helpers ──

describe('isAgentBootstrapMode', () => {
  let ctx: AdminContext;
  let documents: DocumentStore;

  beforeEach(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ax-admin-test-')), 'registry.db');
    const registry = await createSqliteRegistry(dbPath);
    documents = createMemoryDocumentStore();
    await registry.register({
      id: 'main',
      name: 'main',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
    });
    ctx = { registry, documents, agentId: 'main' };
  });

  test('returns true when BOOTSTRAP.md exists and SOUL.md does not', async () => {
    await documents.put('identity', 'main/BOOTSTRAP.md', '# Bootstrap');
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns true when only SOUL.md exists (still missing IDENTITY.md)', async () => {
    await documents.put('identity', 'main/BOOTSTRAP.md', '# Bootstrap');
    await documents.put('identity', 'main/SOUL.md', '# Soul');
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns true when only IDENTITY.md exists (still missing SOUL.md)', async () => {
    await documents.put('identity', 'main/BOOTSTRAP.md', '# Bootstrap');
    await documents.put('identity', 'main/IDENTITY.md', '# Identity');
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns false when both SOUL.md and IDENTITY.md exist (bootstrap complete)', async () => {
    await documents.put('identity', 'main/BOOTSTRAP.md', '# Bootstrap');
    await documents.put('identity', 'main/SOUL.md', '# Soul');
    await documents.put('identity', 'main/IDENTITY.md', '# Identity');
    expect(await isAgentBootstrapMode(ctx)).toBe(false);
  });

  test('returns false when neither file exists', async () => {
    expect(await isAgentBootstrapMode(ctx)).toBe(false);
  });

  test('returns false when only SOUL.md exists (no BOOTSTRAP.md)', async () => {
    await documents.put('identity', 'main/SOUL.md', '# Soul');
    expect(await isAgentBootstrapMode(ctx)).toBe(false);
  });
});

describe('isAdmin', () => {
  let ctx: AdminContext;

  beforeEach(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ax-admin-test-')), 'registry.db');
    const registry = await createSqliteRegistry(dbPath);
    await registry.register({
      id: 'test-agent',
      name: 'test-agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
      admins: ['alice', 'bob'],
    });
    ctx = { registry, documents: createMemoryDocumentStore(), agentId: 'test-agent' };
  });

  test('returns true when userId is in admins list', async () => {
    expect(await isAdmin(ctx, 'alice')).toBe(true);
    expect(await isAdmin(ctx, 'bob')).toBe(true);
  });

  test('returns false when userId is not in admins list', async () => {
    expect(await isAdmin(ctx, 'eve')).toBe(false);
  });

  test('returns false when agent does not exist', async () => {
    const badCtx = { ...ctx, agentId: 'nonexistent' };
    expect(await isAdmin(badCtx, 'alice')).toBe(false);
  });
});

describe('addAdmin', () => {
  let ctx: AdminContext;

  beforeEach(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ax-admin-test-')), 'registry.db');
    const registry = await createSqliteRegistry(dbPath);
    await registry.register({
      id: 'test-agent',
      name: 'test-agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
      admins: ['alice'],
    });
    ctx = { registry, documents: createMemoryDocumentStore(), agentId: 'test-agent' };
  });

  test('adds userId to admins list', async () => {
    await addAdmin(ctx, 'bob');
    expect(await isAdmin(ctx, 'bob')).toBe(true);
    expect(await isAdmin(ctx, 'alice')).toBe(true);
  });

  test('no-op if userId already present', async () => {
    await addAdmin(ctx, 'alice');
    expect(await isAdmin(ctx, 'alice')).toBe(true);
  });
});

describe('claimBootstrapAdmin', () => {
  let ctx: AdminContext;

  beforeEach(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ax-admin-test-')), 'registry.db');
    const registry = await createSqliteRegistry(dbPath);
    const defaultUser = process.env.USER ?? 'default';
    await registry.register({
      id: 'test-agent',
      name: 'test-agent',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
      admins: [defaultUser],
    });
    ctx = { registry, documents: createMemoryDocumentStore(), agentId: 'test-agent' };
  });

  test('first claim succeeds and adds user to admins', async () => {
    expect(await claimBootstrapAdmin(ctx, 'U12345')).toBe(true);
    expect(await isAdmin(ctx, 'U12345')).toBe(true);
  });

  test('second claim fails (already claimed)', async () => {
    expect(await claimBootstrapAdmin(ctx, 'U12345')).toBe(true);
    expect(await claimBootstrapAdmin(ctx, 'U67890')).toBe(false);
    expect(await isAdmin(ctx, 'U67890')).toBe(false);
  });
});

// ── Integration test for channel bootstrap gate ──

describe('bootstrap gate (channel integration)', () => {
  let server: import('../../src/host/server-local.js').AxServer;
  let socketPath: string;
  let originalAxHome: string | undefined;
  let axHome: string;

  beforeEach(() => {
    socketPath = join(tmpdir(), `ax-gate-test-${randomUUID()}.sock`);
    originalAxHome = process.env.AX_HOME;
    axHome = mkdtempSync(join(tmpdir(), 'ax-gate-home-'));
    process.env.AX_HOME = axHome;
  });

  afterEach(async () => {
    if (server) await server.stop();
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    rmSync(axHome, { recursive: true, force: true });
    if (originalAxHome !== undefined) {
      process.env.AX_HOME = originalAxHome;
    } else {
      delete process.env.AX_HOME;
    }
  });

  test('auto-promotes first channel user to admin during bootstrap', async () => {
    const { createServer } = await import('../../src/host/server-local.js');
    const { loadConfig } = await import('../../src/config.js');
    type SessionAddress = import('../../src/providers/channel/types.js').SessionAddress;
    type OutboundMessage = import('../../src/providers/channel/types.js').OutboundMessage;
    type InboundMessage = import('../../src/providers/channel/types.js').InboundMessage;
    type ChannelProvider = import('../../src/providers/channel/types.js').ChannelProvider;

    const sentMessages: { session: SessionAddress; content: OutboundMessage }[] = [];
    let messageHandler: ((msg: InboundMessage) => Promise<void>) | null = null;

    const mockChannel: ChannelProvider = {
      name: 'test',
      async connect() {},
      onMessage(handler) { messageHandler = handler; },
      shouldRespond() { return true; },
      async send(session, content) { sentMessages.push({ session, content }); },
      async disconnect() {},
    };

    const config = loadConfig('tests/integration/ax-test.yaml');
    server = await createServer(config, { socketPath, channels: [mockChannel] });
    await server.start();

    const msg: InboundMessage = {
      id: 'gate-test-1',
      session: { provider: 'test', scope: 'channel', identifiers: { channel: 'C123', peer: 'first-user' } },
      sender: 'first-user',
      content: 'hello',
      attachments: [],
      timestamp: new Date(),
    };

    await messageHandler!(msg);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].content.content).not.toContain('still being set up');
  });
});
