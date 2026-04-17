import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalSandbox } from '../../src/agent/local-sandbox.js';
import type { IPCClient } from '../../src/agent/ipc-client.js';

function mockClient(approveResult: Record<string, unknown> = { approved: true }): IPCClient {
  return {
    call: vi.fn().mockImplementation(async (req: Record<string, unknown>) => {
      if (req.action === 'sandbox_approve') return approveResult;
      if (req.action === 'sandbox_result') return { ok: true };
      return {};
    }),
    connect: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as IPCClient;
}

describe('Local sandbox executor', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'local-sandbox-test-')));
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // ── bash ──

  describe('bash', () => {
    test('executes command when approved', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.bash('echo hello');
      expect(result.output).toContain('hello');

      // Verify sandbox_approve was called
      expect(client.call).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_approve',
          operation: 'bash',
          command: 'echo hello',
        }),
      );

      // Verify sandbox_result was called
      expect(client.call).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sandbox_result',
          operation: 'bash',
          command: 'echo hello',
          exitCode: 0,
        }),
      );
    });

    test('returns denial message when not approved', async () => {
      const client = mockClient({ approved: false, reason: 'blocked by policy' });
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.bash('rm -rf /');
      expect(result.output).toBe('Denied: blocked by policy');

      // sandbox_result should NOT be called
      const resultCalls = (client.call as any).mock.calls.filter(
        (c: any[]) => c[0].action === 'sandbox_result',
      );
      expect(resultCalls).toHaveLength(0);
    });

    test('runs in workspace directory', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.bash('pwd');
      expect(result.output.trim()).toBe(workspace);
    });

    test('reports exit code on failure', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.bash('exit 42');
      expect(result.output).toContain('Exit code 42');
    });

    test('returns "(no output)" for successful command with no stdout/stderr', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.bash('true');
      expect(result.output).toBe('(no output)');
    });

    test('does not return "Command failed" for zero exit code', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      // Redirect output to file — no stdout/stderr
      const result = await sandbox.bash('echo hello > /dev/null');
      expect(result.output).not.toContain('Command failed');
      expect(result.output).toBe('(no output)');
    });

    test('does not make web_proxy_approve calls (auto-approval is host-side)', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      await sandbox.bash('npm install express');

      const calls = (client.call as any).mock.calls.map((c: any[]) => c[0]);
      const proxyApprovals = calls.filter((c: any) => c.action === 'web_proxy_approve');
      expect(proxyApprovals).toHaveLength(0);
    });

    test('kills process on timeout', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace, timeoutMs: 500 });
      // Use node instead of sleep — node exits on SIGTERM while sleep may ignore it
      const result = await sandbox.bash('node -e "setTimeout(()=>{},60000)"');
      expect(result.output).toContain('Exit code');
    }, 15_000);
  });

  // ── readFile ──

  describe('readFile', () => {
    test('reads file when approved', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'file content');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.readFile('test.txt');
      expect(result.content).toBe('file content');
    });

    test('returns denial when not approved', async () => {
      const client = mockClient({ approved: false, reason: 'nope' });
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.readFile('test.txt');
      expect(result.error).toBe('Denied: nope');
    });

    test('returns error for missing file', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.readFile('missing.txt');
      expect(result.error).toMatch(/error reading file/i);
    });

    test('strips workspace prefix when LLM sends absolute path', async () => {
      writeFileSync(join(workspace, 'abs.txt'), 'absolute path content');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.readFile(workspace + '/abs.txt');
      expect(result.content).toBe('absolute path content');
    });
  });

  // ── writeFile ──

  describe('writeFile', () => {
    test('writes file when approved', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.writeFile('new.txt', 'content');
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('content');
    });

    test('creates nested directories', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.writeFile('deep/nested/file.txt', 'data');
      expect(result.written).toBe(true);
      expect(readFileSync(join(workspace, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('data');
    });

    test('returns denial when not approved', async () => {
      const client = mockClient({ approved: false });
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.writeFile('new.txt', 'content');
      expect(result.error).toContain('Denied');
    });

    test('strips workspace prefix when LLM sends absolute path', async () => {
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const absPath = workspace + '/tools/math.js';
      const result = await sandbox.writeFile(absPath, 'export function add(a, b) { return a + b; }');
      expect(result.written).toBe(true);
      // Should be at workspace/tools/math.js, NOT workspace/workspace/tools/math.js
      expect(readFileSync(join(workspace, 'tools', 'math.js'), 'utf-8')).toBe('export function add(a, b) { return a + b; }');
    });
  });

  // ── editFile ──

  describe('editFile', () => {
    test('edits file when approved', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'hello world');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.editFile('edit.txt', 'hello', 'goodbye');
      expect(result.edited).toBe(true);
      expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('goodbye world');
    });

    test('returns error when old_string not found', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'hello world');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.editFile('edit.txt', 'xyz', 'abc');
      expect(result.error).toContain('old_string not found');
    });

    test('returns denial when not approved', async () => {
      const client = mockClient({ approved: false, reason: 'policy' });
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.editFile('edit.txt', 'a', 'b');
      expect(result.error).toBe('Denied: policy');
    });
  });

  // ── glob path="." ──

  describe('glob', () => {
    test('path "." resolves to workspace root, not _empty_', async () => {
      writeFileSync(join(workspace, 'hello.txt'), 'hi');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.glob('**/*', { path: '.' });
      expect(result.files).toContain('hello.txt');
    });

    test('no path defaults to workspace root', async () => {
      writeFileSync(join(workspace, 'hello.txt'), 'hi');
      const client = mockClient();
      const sandbox = createLocalSandbox({ client, workspace });
      const result = await sandbox.glob('**/*');
      expect(result.files).toContain('hello.txt');
    });
  });

});
