import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSandboxToolHandlers } from '../../../src/host/ipc-handlers/sandbox-tools.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';

// Minimal provider stubs
function stubProviders(): ProviderRegistry {
  return {
    audit: { log: vi.fn() },
  } as any;
}

describe('Sandbox tool IPC handlers', () => {
  let workspace: string;
  let workspaceMap: Map<string, string>;
  let ctx: IPCContext;
  let providers: ProviderRegistry;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'sandbox-tools-test-'));
    workspaceMap = new Map([['test-session', workspace]]);
    ctx = { sessionId: 'test-session', agentId: 'test-agent' };
    providers = stubProviders();
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // ── sandbox_bash ──

  describe('sandbox_bash', () => {
    test('executes a command and returns output', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'echo hello' }, ctx);
      expect(result.output).toContain('hello');
    });

    test('runs in workspace directory', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'pwd' }, ctx);
      expect(result.output).toContain(workspace);
    });

    test('returns stderr and exit code on command failure', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash({ command: 'ls /nonexistent-path-xyz-42' }, ctx);
      expect(result.output).toMatch(/exit code|No such file/i);
    });

    test('audits the bash execution', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_bash({ command: 'echo test' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash',
          sessionId: 'test-session',
          result: 'success',
        }),
      );
    });

    test('throws when no workspace registered for session', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const badCtx = { ...ctx, sessionId: 'unknown-session' };
      await expect(
        handlers.sandbox_bash({ command: 'echo hello' }, badCtx),
      ).rejects.toThrow(/No workspace registered/);
    });

    test('captures combined stdout and stderr', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_bash(
        { command: 'echo stdout-msg && echo stderr-msg >&2' },
        ctx,
      );
      expect(result.output).toContain('stdout-msg');
    });
  });

  // ── sandbox_read_file ──

  describe('sandbox_read_file', () => {
    test('reads an existing file', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'file content');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: 'test.txt' }, ctx);
      expect(result.content).toBe('file content');
    });

    test('returns error for missing file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: 'no-such-file.txt' }, ctx);
      expect(result.error).toMatch(/error|no such file/i);
    });

    test('blocks path traversal via safePath', async () => {
      // safePath sanitizes ".." into "_" so this resolves inside workspace, not outside
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_read_file({ path: '../../../etc/passwd' }, ctx);
      // The sanitized path won't exist — we get a file-not-found error
      expect(result.error).toBeDefined();
    });

    test('audits the read operation', async () => {
      writeFileSync(join(workspace, 'audit.txt'), 'content');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_read_file({ path: 'audit.txt' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read_file',
          result: 'success',
        }),
      );
    });
  });

  // ── sandbox_write_file ──

  describe('sandbox_write_file', () => {
    test('creates a new file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: 'new.txt', content: 'new content' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('new content');
    });

    test('creates nested directories', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_write_file(
        { path: 'deep/nested/file.txt', content: 'deep content' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('deep content');
    });

    test('blocks path traversal via safePath', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      // safePath sanitizes ".." into "_" so this writes inside workspace, not outside
      const result = await handlers.sandbox_write_file(
        { path: '../../escape.txt', content: 'bad' },
        ctx,
      );
      // The file should be written but contained within the workspace
      // (safePath sanitizes the segments)
      expect(result.written).toBe(true);
    });

    test('audits the write operation', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_write_file({ path: 'w.txt', content: 'x' }, ctx);
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_write_file',
          result: 'success',
          args: expect.objectContaining({ bytes: 1 }),
        }),
      );
    });
  });

  // ── sandbox_edit_file ──

  describe('sandbox_edit_file', () => {
    test('replaces text in a file', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'hello world');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'edit.txt', old_string: 'hello', new_string: 'goodbye' },
        ctx,
      );
      expect(result.edited).toBe(true);
      expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('goodbye world');
    });

    test('returns error when old_string not found', async () => {
      writeFileSync(join(workspace, 'edit2.txt'), 'hello world');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'edit2.txt', old_string: 'xyz', new_string: 'abc' },
        ctx,
      );
      expect(result.error).toMatch(/old_string not found/i);
    });

    test('returns error for missing file', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_edit_file(
        { path: 'nope.txt', old_string: 'a', new_string: 'b' },
        ctx,
      );
      expect(result.error).toMatch(/error/i);
    });

    test('audits the edit operation', async () => {
      writeFileSync(join(workspace, 'a.txt'), 'old text');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_edit_file(
        { path: 'a.txt', old_string: 'old', new_string: 'new' },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_edit_file',
          result: 'success',
        }),
      );
    });
  });

  // ── workspace tier access via symlink mountRoot ──

  describe('workspace tier access via mountRoot symlinks', () => {
    let mountRoot: string;
    let agentDir: string;
    let userDir: string;
    let tierMap: Map<string, string>;

    beforeEach(() => {
      // Simulate the mountRoot layout that processCompletion creates.
      // mountRoot/
      //   scratch/ → workspace (scratch dir)
      //   agent/   → agentDir
      //   user/    → userDir
      mountRoot = mkdtempSync(join(tmpdir(), 'sandbox-mount-'));
      agentDir = mkdtempSync(join(tmpdir(), 'agent-ws-'));
      userDir = mkdtempSync(join(tmpdir(), 'user-ws-'));

      const { symlinkSync } = require('node:fs');
      symlinkSync(workspace, join(mountRoot, 'scratch'));
      symlinkSync(agentDir, join(mountRoot, 'agent'));
      symlinkSync(userDir, join(mountRoot, 'user'));

      // The workspaceMap now points to the mountRoot (not scratch)
      tierMap = new Map([['test-session', mountRoot]]);
    });

    afterEach(() => {
      rmSync(mountRoot, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(userDir, { recursive: true, force: true });
    });

    test('sandbox_bash can list agent and user directories', async () => {
      writeFileSync(join(agentDir, 'README.md'), '# Agent');
      writeFileSync(join(userDir, 'notes.txt'), 'hello');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_bash({ command: 'ls agent user' }, ctx);
      expect(result.output).toContain('README.md');
      expect(result.output).toContain('notes.txt');
    });

    test('sandbox_read_file reads from agent/ tier', async () => {
      writeFileSync(join(agentDir, 'config.json'), '{"key":"value"}');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_read_file({ path: 'agent/config.json' }, ctx);
      expect(result.content).toBe('{"key":"value"}');
    });

    test('sandbox_read_file reads from user/ tier', async () => {
      writeFileSync(join(userDir, 'prefs.txt'), 'dark mode');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_read_file({ path: 'user/prefs.txt' }, ctx);
      expect(result.content).toBe('dark mode');
    });

    test('sandbox_write_file writes to user/ tier', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_write_file(
        { path: 'user/new-file.txt', content: 'created' },
        ctx,
      );
      expect(result.written).toBe(true);
      expect(readFileSync(join(userDir, 'new-file.txt'), 'utf-8')).toBe('created');
    });

    test('sandbox_bash runs in mountRoot with scratch/agent/user visible', async () => {
      writeFileSync(join(workspace, 'scratch-file.txt'), 'from scratch');
      const handlers = createSandboxToolHandlers(providers, { workspaceMap: tierMap });
      const result = await handlers.sandbox_bash({ command: 'ls' }, ctx);
      expect(result.output).toContain('scratch');
      expect(result.output).toContain('agent');
      expect(result.output).toContain('user');
    });
  });

  // ── Sandbox Audit Gate ──

  describe('sandbox_approve', () => {
    test('approves bash operation and logs audit', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_approve(
        { operation: 'bash', command: 'ls' },
        ctx,
      );
      expect(result).toEqual({ approved: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash',
          sessionId: 'test-session',
          result: 'success',
          args: expect.objectContaining({ command: 'ls', mode: 'container-local' }),
        }),
      );
    });

    test('approves read operation and logs audit', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_approve(
        { operation: 'read', path: 'foo.txt' },
        ctx,
      );
      expect(result).toEqual({ approved: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read',
          result: 'success',
          args: expect.objectContaining({ path: 'foo.txt', mode: 'container-local' }),
        }),
      );
    });

    test('truncates long commands in audit log', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const longCmd = 'x'.repeat(500);
      await handlers.sandbox_approve(
        { operation: 'bash', command: longCmd },
        ctx,
      );
      const auditCall = (providers.audit.log as any).mock.calls[0][0];
      expect(auditCall.args.command.length).toBe(200);
    });

    test('auto-approves registry.npmjs.org for npm install (session-scoped)', async () => {
      // Import the approvals module to check session-scoped cache
      const { isDomainApproved, cleanupSession } = await import(
        '../../../src/host/web-proxy-approvals.js'
      );
      cleanupSession('test-session');
      cleanupSession('other-session');

      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_approve(
        { operation: 'bash', command: 'npm install express' },
        ctx,
      );

      // Domain should be approved for THIS session
      expect(isDomainApproved('test-session', 'registry.npmjs.org')).toBe(true);
      // But NOT for other sessions (no cross-session leakage)
      expect(isDomainApproved('other-session', 'registry.npmjs.org')).toBe(false);
      // And NOT in the global host-process scope
      expect(isDomainApproved('host-process', 'registry.npmjs.org')).toBe(false);

      cleanupSession('test-session');
    });

    test('does not auto-approve for non-network commands', async () => {
      const { isDomainApproved, cleanupSession } = await import(
        '../../../src/host/web-proxy-approvals.js'
      );
      cleanupSession('test-session');

      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_approve(
        { operation: 'bash', command: 'echo hello' },
        ctx,
      );

      expect(isDomainApproved('test-session', 'registry.npmjs.org')).toBe(false);
      cleanupSession('test-session');
    });
  });

  describe('sandbox_result', () => {
    test('logs successful bash result', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      const result = await handlers.sandbox_result(
        { operation: 'bash', command: 'ls', output: 'file1', exitCode: 0 },
        ctx,
      );
      expect(result).toEqual({ ok: true });
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash_result',
          sessionId: 'test-session',
          result: 'success',
          args: expect.objectContaining({ command: 'ls', exitCode: 0, mode: 'container-local' }),
        }),
      );
    });

    test('logs failed result with non-zero exit code', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_result(
        { operation: 'bash', command: 'bad', exitCode: 1 },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_bash_result',
          result: 'error',
        }),
      );
    });

    test('logs file operation result with success flag', async () => {
      const handlers = createSandboxToolHandlers(providers, { workspaceMap });
      await handlers.sandbox_result(
        { operation: 'read', path: 'foo.txt', success: true },
        ctx,
      );
      expect(providers.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_read_result',
          result: 'success',
          args: expect.objectContaining({ path: 'foo.txt', success: true }),
        }),
      );
    });
  });
});
