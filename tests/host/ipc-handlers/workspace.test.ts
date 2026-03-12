import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

// Stub paths.ts to use temp directories
let tmpDir: string;
let agentWsDir: string;
let userWsDir: string;

vi.mock('../../../src/paths.js', () => ({
  agentWorkspaceDir: () => agentWsDir,
  userWorkspaceDir: () => userWsDir,
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
    mkdirSync(agentWsDir, { recursive: true });
    mkdirSync(userWsDir, { recursive: true });

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

  test('workspace_write calls workspaceSync.uploadFile after write', async () => {
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const providers = stubProviders();
    (providers as any).workspaceSync = {
      uploadFile,
      pull: vi.fn(),
      pushAll: vi.fn(),
      deleteFile: vi.fn(),
    };
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    await handlers.workspace_write(
      { tier: 'user', path: 'synced.md', content: 'sync me' },
      ctx,
    );

    // Fire-and-forget: give microtask a tick to resolve
    await new Promise(r => setTimeout(r, 10));
    expect(uploadFile).toHaveBeenCalledWith(
      userWsDir,
      'workspaces/main/users/testuser/',
      'synced.md',
    );
  });

  test('workspace_write_file calls workspaceSync.uploadFile after write', async () => {
    const uploadFile = vi.fn().mockResolvedValue(undefined);
    const providers = stubProviders();
    (providers as any).workspaceSync = {
      uploadFile,
      pull: vi.fn(),
      pushAll: vi.fn(),
      deleteFile: vi.fn(),
    };
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const data = Buffer.from('binary data').toString('base64');
    await handlers.workspace_write_file(
      { tier: 'agent', path: 'file.bin', data, mimeType: 'application/octet-stream' },
      ctx,
    );

    await new Promise(r => setTimeout(r, 10));
    expect(uploadFile).toHaveBeenCalledWith(
      agentWsDir,
      'workspaces/main/agent/',
      'file.bin',
    );
  });

  test('workspace_write works without workspaceSync configured', async () => {
    const providers = stubProviders();
    // No workspaceSync set — should not crash
    const handlers = createWorkspaceHandlers(providers, { agentName: 'main', profile: 'balanced' });

    const result = await handlers.workspace_write(
      { tier: 'user', path: 'no-sync.md', content: 'no sync provider' },
      ctx,
    );

    expect(result.written).toBe(true);
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
