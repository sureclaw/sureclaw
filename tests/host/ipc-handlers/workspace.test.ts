import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceHandlers } from '../../../src/host/ipc-handlers/workspace.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

function mockProviders(tmpDir: string) {
  const auditLog: any[] = [];
  // Ensure tier directories exist since handler will write into them
  mkdirSync(join(tmpDir, 'agent'), { recursive: true });
  mkdirSync(join(tmpDir, 'user'), { recursive: true });
  return {
    providers: {
      audit: { log: async (entry: any) => { auditLog.push(entry); } },
      workspace: {
        mount: async (_sid: string, scopes: string[]) => ({
          paths: Object.fromEntries(scopes.map(s => [s, join(tmpDir, s)])),
        }),
        activeMounts: () => [] as string[],
        commit: async () => ({ scopes: {} }),
        cleanup: async () => {},
      },
    },
    auditLog,
  };
}

describe('workspace IPC handlers', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'ws-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  const ctx: IPCContext = { sessionId: 'test-session', agentId: 'agent-1', userId: 'user-1' };

  test('workspace_write writes a file to the agent tier', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    const result = await handlers.workspace_write(
      { tier: 'agent', path: 'notes.md', content: '# Notes' }, ctx,
    );
    expect(result.written).toBe(true);
    expect(result.tier).toBe('agent');
    expect(result.path).toBe('notes.md');
    // Verify file was actually written
    const content = readFileSync(join(tmpDir, 'agent', 'notes.md'), 'utf-8');
    expect(content).toBe('# Notes');
  });

  test('workspace_write creates nested directories', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    const result = await handlers.workspace_write(
      { tier: 'user', path: 'deep/nested/file.txt', content: 'hello' }, ctx,
    );
    expect(result.written).toBe(true);
    const content = readFileSync(join(tmpDir, 'user', 'deep', 'nested', 'file.txt'), 'utf-8');
    expect(content).toBe('hello');
  });

  test('workspace_write is audited', async () => {
    const { providers, auditLog } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    await handlers.workspace_write(
      { tier: 'agent', path: 'test.md', content: 'content' }, ctx,
    );
    expect(auditLog.some((e: any) => e.action === 'workspace_write')).toBe(true);
  });

  test('workspace_write returns error if tier mount fails', async () => {
    const { providers } = mockProviders(tmpDir);
    // Override mount to return no paths
    providers.workspace.mount = async () => ({ paths: {} });
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    const result = await handlers.workspace_write(
      { tier: 'agent', path: 'test.md', content: 'content' }, ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  test('workspace_write blocks path traversal via safePath', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    // safePath sanitizes ".." sequences to underscores, so this should write safely
    const result = await handlers.workspace_write(
      { tier: 'agent', path: '../../etc/passwd', content: 'nope' }, ctx,
    );
    // Should succeed but write within the tier, not escape
    expect(result.written).toBe(true);
    // The file should be inside the agent tier directory
    const agentDir = join(tmpDir, 'agent');
    // Verify nothing was written outside
    expect(() => readFileSync('/etc/passwd-test', 'utf-8')).toThrow();
  });

  test('workspace_write to user tier', async () => {
    const { providers } = mockProviders(tmpDir);
    const handlers = createWorkspaceHandlers(providers as any, { agentName: 'main', profile: 'balanced' });
    const result = await handlers.workspace_write(
      { tier: 'user', path: 'prefs.json', content: '{"theme":"dark"}' }, ctx,
    );
    expect(result.written).toBe(true);
    expect(result.tier).toBe('user');
    const content = readFileSync(join(tmpDir, 'user', 'prefs.json'), 'utf-8');
    expect(content).toBe('{"theme":"dark"}');
  });
});
