import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createIdentityHandlers } from '../../../src/host/ipc-handlers/identity.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

let tmpDir: string;
let agentDirPath: string;
let agentTopDirPath: string;
let agentConfigDirPath: string;

vi.mock('../../../src/paths.js', () => ({
  agentDir: () => agentTopDirPath,
  agentIdentityDir: () => agentConfigDirPath,
  agentIdentityFilesDir: () => agentDirPath,
  agentUserDir: (_agent: string, userId: string) => join(agentTopDirPath, 'users', userId),
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

function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
    scanner: { scanInput: vi.fn().mockResolvedValue({ verdict: 'PASS' }) },
  } as any;
}

describe('Identity IPC handlers', () => {
  let ctx: IPCContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-id-test-'));
    agentTopDirPath = join(tmpDir, 'top');
    agentConfigDirPath = join(tmpDir, 'config');
    agentDirPath = join(tmpDir, 'agent');
    mkdirSync(agentDirPath, { recursive: true });
    mkdirSync(agentConfigDirPath, { recursive: true });
    mkdirSync(agentTopDirPath, { recursive: true });

    ctx = { sessionId: 'sess-1', agentId: 'main', userId: 'alice' };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── identity_read ──

  test('identity_read returns file content when file exists', async () => {
    writeFileSync(join(agentDirPath, 'SOUL.md'), '# My Soul', 'utf-8');
    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_read({ file: 'SOUL.md' }, ctx);

    expect(result.content).toBe('# My Soul');
    expect(result.file).toBe('SOUL.md');
  });

  test('identity_read returns empty string for missing file', async () => {
    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_read({ file: 'IDENTITY.md' }, ctx);

    expect(result.content).toBe('');
    expect(result.file).toBe('IDENTITY.md');
  });

  test('identity_read returns empty string when agentDir not configured', async () => {
    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_read({ file: 'SOUL.md' }, ctx);

    expect(result.content).toBe('');
    expect(result.file).toBe('SOUL.md');
  });

  // ── identity_write admin gate ──

  test('identity_write rejects non-admin users', async () => {
    // Create admins file WITHOUT alice
    writeFileSync(join(agentTopDirPath, 'admins'), 'bob\n', 'utf-8');

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: 'hacked', reason: 'test', origin: 'user_request' },
      ctx,
    );

    expect(result.queued).toBe(true);
    expect(result.reason).toContain('Non-admin');
    // File should NOT be written
    expect(existsSync(join(agentDirPath, 'SOUL.md'))).toBe(false);
  });

  test('identity_write allows admin users', async () => {
    // Create admins file WITH alice
    writeFileSync(join(agentTopDirPath, 'admins'), 'alice\n', 'utf-8');

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.identity_write(
      { file: 'SOUL.md', content: '# My Soul', reason: 'test', origin: 'user_request' },
      ctx,
    );

    expect(result.applied).toBe(true);
    expect(readFileSync(join(agentDirPath, 'SOUL.md'), 'utf-8')).toBe('# My Soul');
  });

  test('identity_write allows when no userId (system context)', async () => {
    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
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
  });

  // ── user_write admin gate ──

  test('user_write rejects non-admin writing another user file', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), 'bob\n', 'utf-8');

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
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

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'alice', content: '# Alice prefs', reason: 'test', origin: 'user_request' },
      ctx, // alice writing alice's file — allowed
    );

    expect(result.applied).toBe(true);
  });

  test('user_write allows admin writing another user file', async () => {
    writeFileSync(join(agentTopDirPath, 'admins'), 'alice\n', 'utf-8');

    const providers = stubProviders();
    const handlers = createIdentityHandlers(providers, {
      agentDir: agentDirPath,
      agentName: 'main',
      profile: 'balanced',
    });

    const result = await handlers.user_write(
      { userId: 'bob', content: '# Bob prefs', reason: 'admin edit', origin: 'user_request' },
      ctx, // alice (admin) writing bob's file — allowed
    );

    expect(result.applied).toBe(true);
  });
});
