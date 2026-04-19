import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { isAgentBootstrapMode, isAdmin, addAdmin, claimBootstrapAdmin, type AdminContext } from '../../src/host/server-admin-helpers.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import type { WorkspaceProvider } from '../../src/providers/workspace/types.js';

/** Mock workspace provider that returns identity from a map. */
function createMockWorkspace(identityMap: Record<string, string> = {}): WorkspaceProvider {
  return {
    async getRepoUrl() { return { url: 'file:///mock-repo', created: false }; },
    async ensureLocalMirror() { return '/mock-repo'; },
    async commitFiles() { return { commit: null, changed: false }; },
    async close() {},
  };
}

// Mock identity-reader to return controlled identity payloads
vi.mock('../../src/host/identity-reader.js', () => ({
  readIdentityForAgent: vi.fn(async () => ({})),
  loadIdentityFromGit: vi.fn(() => ({})),
  fetchIdentityFromRemote: vi.fn(() => ({ gitDir: '/tmp/mock', identity: {} })),
  clearIdentityCache: vi.fn(),
  IDENTITY_FILE_MAP: [],
}));

import { readIdentityForAgent } from '../../src/host/identity-reader.js';

// ── Unit tests for helpers ──

describe('isAgentBootstrapMode', () => {
  let ctx: AdminContext;

  beforeEach(async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'ax-admin-test-')), 'registry.db');
    const registry = await createSqliteRegistry(dbPath);
    await registry.register({
      id: 'main',
      name: 'main',
      status: 'active',
      parentId: null,
      agentType: 'pi-coding-agent',
      capabilities: [],
      createdBy: 'system',
    });
    ctx = { registry, agentId: 'main', workspace: createMockWorkspace() };
  });

  test('returns true when SOUL.md is missing', async () => {
    vi.mocked(readIdentityForAgent).mockResolvedValue({ identity: 'I am AX.' });
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns true when IDENTITY.md is missing', async () => {
    vi.mocked(readIdentityForAgent).mockResolvedValue({ soul: 'I am thoughtful.' });
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns true when both are missing', async () => {
    vi.mocked(readIdentityForAgent).mockResolvedValue({});
    expect(await isAgentBootstrapMode(ctx)).toBe(true);
  });

  test('returns false when both SOUL.md and IDENTITY.md exist', async () => {
    vi.mocked(readIdentityForAgent).mockResolvedValue({ soul: 'Soul.', identity: 'Identity.' });
    expect(await isAgentBootstrapMode(ctx)).toBe(false);
  });

  test('returns true when no workspace provider', async () => {
    const noWsCtx = { ...ctx, workspace: undefined };
    expect(await isAgentBootstrapMode(noWsCtx)).toBe(true);
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
    ctx = { registry, agentId: 'test-agent' };
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
    ctx = { registry, agentId: 'test-agent' };
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
    ctx = { registry, agentId: 'test-agent' };
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
  let server: import('../../src/host/server.js').AxServer;
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
    const { createServer } = await import('../../src/host/server.js');
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
