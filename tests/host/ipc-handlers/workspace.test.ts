import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

// Stub paths.ts to use temp directories
let tmpDir: string;
let agentWsDir: string;
let userWsDir: string;
let scratchWsDir: string;

vi.mock('../../../src/paths.js', () => ({
  agentWorkspaceDir: () => agentWsDir,
  userWorkspaceDir: () => userWsDir,
  scratchDir: () => scratchWsDir,
}));

// Minimal provider stubs
function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
    scanner: { scanInput: vi.fn().mockResolvedValue({ verdict: 'PASS' }) },
  } as any;
}

describe('Workspace IPC handlers', () => {
  let ctx: IPCContext;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-ws-test-'));
    agentWsDir = join(tmpDir, 'agent-workspace');
    userWsDir = join(tmpDir, 'user-workspace');
    scratchWsDir = join(tmpDir, 'scratch');
    mkdirSync(agentWsDir, { recursive: true });
    mkdirSync(userWsDir, { recursive: true });
    mkdirSync(scratchWsDir, { recursive: true });

    ctx = { sessionId: 'test-session', agentId: 'test-agent', userId: 'testuser' };
  });

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  test('workspace_write writes file to user tier', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'user', path: 'notes.md', content: '# Notes\nHello world' },
      ctx,
    );

    expect(result.written).toBe(true);
    expect(result.tier).toBe('user');
    const content = readFileSync(join(userWsDir, 'notes.md'), 'utf-8');
    expect(content).toBe('# Notes\nHello world');
  });

  test('workspace_write writes file to scratch tier', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'scratch', path: 'temp.txt', content: 'ephemeral data' },
      ctx,
    );

    expect(result.written).toBe(true);
    const content = readFileSync(join(scratchWsDir, 'temp.txt'), 'utf-8');
    expect(content).toBe('ephemeral data');
  });

  test('workspace_write queues agent tier writes in paranoid mode', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'paranoid' });

    const result = await handlers.workspace_write(
      { tier: 'agent', path: 'shared.md', content: 'shared content' },
      ctx,
    );

    expect(result.queued).toBe(true);
    expect(result.reason).toContain('paranoid');
  });

  test('workspace_write blocks content flagged by scanner', async () => {
    const providers = stubProviders();
    (providers.scanner.scanInput as any).mockResolvedValue({ verdict: 'BLOCK', reason: 'injection detected' });
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'user', path: 'bad.md', content: '<script>alert(1)</script>' },
      ctx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('blocked');
  });

  test('workspace_read returns file content', async () => {
    writeFileSync(join(userWsDir, 'readme.md'), '# Readme', 'utf-8');

    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_read({ tier: 'user', path: 'readme.md' }, ctx);
    expect(result.content).toBe('# Readme');
  });

  test('workspace_read returns error for missing file', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_read({ tier: 'user', path: 'nope.md' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });

  test('workspace_list returns directory entries', async () => {
    writeFileSync(join(scratchWsDir, 'a.txt'), 'a', 'utf-8');
    writeFileSync(join(scratchWsDir, 'b.txt'), 'b', 'utf-8');
    mkdirSync(join(scratchWsDir, 'subdir'));

    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_list({ tier: 'scratch' }, ctx);
    expect(result.files).toHaveLength(3);
    const names = result.files.map((f: any) => f.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  test('workspace_list returns empty for non-existent path', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_list({ tier: 'user', path: 'nonexistent' }, ctx);
    expect(result.files).toEqual([]);
  });

  test('workspace_write creates nested directories', async () => {
    const providers = stubProviders();
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'user', path: 'deep/nested/file.txt', content: 'deep content' },
      ctx,
    );

    expect(result.written).toBe(true);
    const content = readFileSync(join(userWsDir, 'deep', 'nested', 'file.txt'), 'utf-8');
    expect(content).toBe('deep content');
  });
});
