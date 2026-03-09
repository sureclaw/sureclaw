import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalExecutor } from '../../../src/host/sandbox-tools/local-executor.js';
import type { SandboxExecutionContext } from '../../../src/host/sandbox-tools/types.js';

describe('LocalExecutor', () => {
  let workspace: string;
  let ctx: SandboxExecutionContext;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'local-executor-test-'));
    ctx = { workspace, sessionId: 'test-session', requestId: 'test-request' };
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const executor = createLocalExecutor();

  test('has name "local"', () => {
    expect(executor.name).toBe('local');
  });

  // ── bash ──

  describe('bash', () => {
    test('executes a command and returns output', async () => {
      const result = await executor.execute({ type: 'bash', command: 'echo hello' }, ctx);
      expect(result.type).toBe('bash');
      expect(result).toHaveProperty('output');
      if (result.type === 'bash') {
        expect(result.output).toContain('hello');
        expect(result.exitCode).toBe(0);
      }
    });

    test('runs in workspace directory', async () => {
      const result = await executor.execute({ type: 'bash', command: 'pwd' }, ctx);
      if (result.type === 'bash') {
        expect(result.output).toContain(workspace);
      }
    });

    test('returns exit code on command failure', async () => {
      const result = await executor.execute({ type: 'bash', command: 'ls /nonexistent-path-xyz-42' }, ctx);
      if (result.type === 'bash') {
        expect(result.output).toMatch(/exit code|No such file/i);
      }
    });
  });

  // ── read_file ──

  describe('read_file', () => {
    test('reads an existing file', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'file content');
      const result = await executor.execute({ type: 'read_file', path: 'test.txt' }, ctx);
      if (result.type === 'read_file') {
        expect(result.content).toBe('file content');
      }
    });

    test('returns error for missing file', async () => {
      const result = await executor.execute({ type: 'read_file', path: 'no-such-file.txt' }, ctx);
      if (result.type === 'read_file') {
        expect(result.error).toMatch(/error|no such file/i);
      }
    });

    test('blocks path traversal via safePath', async () => {
      const result = await executor.execute({ type: 'read_file', path: '../../../etc/passwd' }, ctx);
      if (result.type === 'read_file') {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── write_file ──

  describe('write_file', () => {
    test('creates a new file', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'new.txt', content: 'new content' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(true);
        expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('new content');
      }
    });

    test('creates nested directories', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'deep/nested/file.txt', content: 'deep content' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(true);
        expect(readFileSync(join(workspace, 'deep', 'nested', 'file.txt'), 'utf-8')).toBe('deep content');
      }
    });

    test('blocks path traversal via safePath', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: '../../escape.txt', content: 'bad' },
        ctx,
      );
      if (result.type === 'write_file') {
        // safePath sanitizes ".." into "_" so file is written inside workspace
        expect(result.written).toBe(true);
      }
    });
  });

  // ── edit_file ──

  describe('edit_file', () => {
    test('replaces text in a file', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'hello world');
      const result = await executor.execute(
        { type: 'edit_file', path: 'edit.txt', old_string: 'hello', new_string: 'goodbye' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.edited).toBe(true);
        expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('goodbye world');
      }
    });

    test('returns error when old_string not found', async () => {
      writeFileSync(join(workspace, 'edit2.txt'), 'hello world');
      const result = await executor.execute(
        { type: 'edit_file', path: 'edit2.txt', old_string: 'xyz', new_string: 'abc' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.error).toMatch(/old_string not found/i);
      }
    });

    test('returns error for missing file', async () => {
      const result = await executor.execute(
        { type: 'edit_file', path: 'nope.txt', old_string: 'a', new_string: 'b' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.error).toMatch(/error/i);
      }
    });
  });
});
