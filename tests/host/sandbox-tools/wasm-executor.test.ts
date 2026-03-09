import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWasmExecutor } from '../../../src/host/sandbox-tools/wasm-executor.js';
import type { SandboxExecutionContext } from '../../../src/host/sandbox-tools/types.js';

describe('WasmExecutor', () => {
  let workspace: string;
  let ctx: SandboxExecutionContext;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'wasm-executor-test-'));
    ctx = { workspace, sessionId: 'test-session', requestId: 'test-request' };
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  const executor = createWasmExecutor();

  test('has name "wasm"', () => {
    expect(executor.name).toBe('wasm');
  });

  // ── Contract parity: read_file ──

  describe('read_file', () => {
    test('reads an existing file', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'hello world');
      const result = await executor.execute({ type: 'read_file', path: 'test.txt' }, ctx);
      expect(result.type).toBe('read_file');
      if (result.type === 'read_file') {
        expect(result.content).toBe('hello world');
      }
    });

    test('returns error for missing file', async () => {
      const result = await executor.execute({ type: 'read_file', path: 'missing.txt' }, ctx);
      if (result.type === 'read_file') {
        expect(result.error).toMatch(/error/i);
      }
    });

    test('blocks path traversal', async () => {
      const result = await executor.execute({ type: 'read_file', path: '../../../etc/passwd' }, ctx);
      if (result.type === 'read_file') {
        expect(result.error).toBeDefined();
      }
    });
  });

  // ── Contract parity: write_file ──

  describe('write_file', () => {
    test('creates a new file', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'new.txt', content: 'content' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(true);
        expect(readFileSync(join(workspace, 'new.txt'), 'utf-8')).toBe('content');
      }
    });

    test('creates nested directories', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'deep/nested/file.txt', content: 'deep' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(true);
      }
    });
  });

  // ── Contract parity: edit_file ──

  describe('edit_file', () => {
    test('replaces text in a file', async () => {
      writeFileSync(join(workspace, 'edit.txt'), 'old text');
      const result = await executor.execute(
        { type: 'edit_file', path: 'edit.txt', old_string: 'old', new_string: 'new' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.edited).toBe(true);
        expect(readFileSync(join(workspace, 'edit.txt'), 'utf-8')).toBe('new text');
      }
    });

    test('returns error when old_string not found', async () => {
      writeFileSync(join(workspace, 'edit2.txt'), 'hello');
      const result = await executor.execute(
        { type: 'edit_file', path: 'edit2.txt', old_string: 'xyz', new_string: 'abc' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.error).toMatch(/old_string not found/i);
      }
    });
  });

  // ── Contract parity: bash ──

  describe('bash', () => {
    test('executes a command and returns output', async () => {
      const result = await executor.execute({ type: 'bash', command: 'echo hello' }, ctx);
      if (result.type === 'bash') {
        expect(result.output).toContain('hello');
      }
    });

    test('runs in workspace directory', async () => {
      const result = await executor.execute({ type: 'bash', command: 'pwd' }, ctx);
      if (result.type === 'bash') {
        expect(result.output).toContain(workspace);
      }
    });
  });

  // ── Security: protected files ──

  describe('protected file enforcement', () => {
    test('rejects writes to .env', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: '.env', content: 'SECRET=bad' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(false);
        expect(result.error).toContain('Policy error');
        expect(result.error).toContain('protected');
      }
    });

    test('rejects writes to .env.local', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: '.env.local', content: 'SECRET=bad' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.error).toContain('protected');
      }
    });

    test('rejects writes to credentials.json', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'credentials.json', content: '{}' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.error).toContain('protected');
      }
    });

    test('rejects writes to .npmrc', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: '.npmrc', content: 'token=bad' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.error).toContain('protected');
      }
    });

    test('rejects writes to nested .env', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'config/.env', content: 'SECRET=bad' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.error).toContain('protected');
      }
    });

    test('allows writes to regular files', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: 'readme.md', content: '# Hello' },
        ctx,
      );
      if (result.type === 'write_file') {
        expect(result.written).toBe(true);
      }
    });

    test('rejects edit_file targeting .env', async () => {
      // Even though the file doesn't exist, the protected path check should fire
      // on the write part of the edit
      writeFileSync(join(workspace, '.env'), 'KEY=old');
      const result = await executor.execute(
        { type: 'edit_file', path: '.env', old_string: 'old', new_string: 'new' },
        ctx,
      );
      if (result.type === 'edit_file') {
        expect(result.error).toContain('protected');
      }
    });
  });

  // ── Security: deterministic failures don't fall back ──

  describe('deterministic policy failures', () => {
    test('protected path write returns error, does not throw', async () => {
      const result = await executor.execute(
        { type: 'write_file', path: '.env', content: 'bad' },
        ctx,
      );
      // Should return error response, not throw
      expect(result.type).toBe('write_file');
      if (result.type === 'write_file') {
        expect(result.error).toContain('Policy error');
      }
    });
  });

  // ── Concurrency ──

  describe('concurrent invocations', () => {
    test('handles multiple concurrent file reads', async () => {
      writeFileSync(join(workspace, 'a.txt'), 'content-a');
      writeFileSync(join(workspace, 'b.txt'), 'content-b');
      writeFileSync(join(workspace, 'c.txt'), 'content-c');

      const results = await Promise.all([
        executor.execute({ type: 'read_file', path: 'a.txt' }, ctx),
        executor.execute({ type: 'read_file', path: 'b.txt' }, ctx),
        executor.execute({ type: 'read_file', path: 'c.txt' }, ctx),
      ]);

      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(result.type).toBe('read_file');
        if (result.type === 'read_file') {
          expect(result.content).toBeTruthy();
        }
      }
    });

    test('handles concurrent writes to different files', async () => {
      const results = await Promise.all([
        executor.execute({ type: 'write_file', path: 'w1.txt', content: 'one' }, ctx),
        executor.execute({ type: 'write_file', path: 'w2.txt', content: 'two' }, ctx),
        executor.execute({ type: 'write_file', path: 'w3.txt', content: 'three' }, ctx),
      ]);

      for (const result of results) {
        if (result.type === 'write_file') {
          expect(result.written).toBe(true);
        }
      }

      expect(readFileSync(join(workspace, 'w1.txt'), 'utf-8')).toBe('one');
      expect(readFileSync(join(workspace, 'w2.txt'), 'utf-8')).toBe('two');
      expect(readFileSync(join(workspace, 'w3.txt'), 'utf-8')).toBe('three');
    });
  });
});
