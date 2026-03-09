/**
 * Contract parity tests: verify that Local and WASM executors produce
 * the same response shapes and semantics for all sandbox tool operations.
 *
 * This is acceptance criteria #1 from the unified WASM sandbox plan.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLocalExecutor } from '../../../src/host/sandbox-tools/local-executor.js';
import { createWasmExecutor } from '../../../src/host/sandbox-tools/wasm-executor.js';
import type { SandboxToolRequest, SandboxToolResponse, SandboxExecutionContext } from '../../../src/host/sandbox-tools/types.js';

describe('Contract parity: Local vs WASM executor', () => {
  let workspace: string;
  let ctx: SandboxExecutionContext;

  const local = createLocalExecutor();
  const wasm = createWasmExecutor();

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'parity-test-'));
    ctx = { workspace, sessionId: 'parity-session', requestId: 'parity-req' };
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  /**
   * Helper: run the same request through both executors and return results.
   */
  async function runBoth(request: SandboxToolRequest): Promise<{ local: SandboxToolResponse; wasm: SandboxToolResponse }> {
    const [localResult, wasmResult] = await Promise.all([
      local.execute(request, ctx),
      wasm.execute(request, ctx),
    ]);
    return { local: localResult, wasm: wasmResult };
  }

  // ── read_file ──

  describe('read_file', () => {
    test('both return same content for existing file', async () => {
      writeFileSync(join(workspace, 'parity.txt'), 'parity content');
      const { local: l, wasm: w } = await runBoth({ type: 'read_file', path: 'parity.txt' });
      expect(l.type).toBe('read_file');
      expect(w.type).toBe('read_file');
      if (l.type === 'read_file' && w.type === 'read_file') {
        expect(l.content).toBe(w.content);
        expect(l.content).toBe('parity content');
      }
    });

    test('both return error for missing file', async () => {
      const { local: l, wasm: w } = await runBoth({ type: 'read_file', path: 'nonexistent.txt' });
      if (l.type === 'read_file' && w.type === 'read_file') {
        expect(l.error).toBeDefined();
        expect(w.error).toBeDefined();
      }
    });

    test('both handle path traversal', async () => {
      const { local: l, wasm: w } = await runBoth({ type: 'read_file', path: '../../../etc/passwd' });
      if (l.type === 'read_file' && w.type === 'read_file') {
        // Both should error — either path sanitization or file not found
        expect(l.error).toBeDefined();
        expect(w.error).toBeDefined();
      }
    });

    test('both read binary-safe content', async () => {
      const content = 'line1\nline2\ttab\r\nwindows';
      writeFileSync(join(workspace, 'mixed.txt'), content);
      const { local: l, wasm: w } = await runBoth({ type: 'read_file', path: 'mixed.txt' });
      if (l.type === 'read_file' && w.type === 'read_file') {
        expect(l.content).toBe(w.content);
        expect(l.content).toBe(content);
      }
    });
  });

  // ── write_file ──

  describe('write_file', () => {
    test('both create files with same content', async () => {
      // Run sequentially to avoid writing to the same file
      const localResult = await local.execute(
        { type: 'write_file', path: 'local-out.txt', content: 'written' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'write_file', path: 'wasm-out.txt', content: 'written' }, ctx,
      );
      if (localResult.type === 'write_file' && wasmResult.type === 'write_file') {
        expect(localResult.written).toBe(true);
        expect(wasmResult.written).toBe(true);
        expect(readFileSync(join(workspace, 'local-out.txt'), 'utf-8')).toBe('written');
        expect(readFileSync(join(workspace, 'wasm-out.txt'), 'utf-8')).toBe('written');
      }
    });

    test('both create nested directories', async () => {
      const localResult = await local.execute(
        { type: 'write_file', path: 'a/b/local.txt', content: 'deep' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'write_file', path: 'c/d/wasm.txt', content: 'deep' }, ctx,
      );
      if (localResult.type === 'write_file' && wasmResult.type === 'write_file') {
        expect(localResult.written).toBe(true);
        expect(wasmResult.written).toBe(true);
      }
    });

    test('both return same response shape', async () => {
      const localResult = await local.execute(
        { type: 'write_file', path: 'shape-local.txt', content: 'x' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'write_file', path: 'shape-wasm.txt', content: 'x' }, ctx,
      );
      // Both should have the same keys
      expect(Object.keys(localResult).sort()).toEqual(Object.keys(wasmResult).sort());
    });
  });

  // ── edit_file ──

  describe('edit_file', () => {
    test('both produce same edited result', async () => {
      writeFileSync(join(workspace, 'edit-local.txt'), 'hello world');
      writeFileSync(join(workspace, 'edit-wasm.txt'), 'hello world');

      const localResult = await local.execute(
        { type: 'edit_file', path: 'edit-local.txt', old_string: 'hello', new_string: 'goodbye' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'edit_file', path: 'edit-wasm.txt', old_string: 'hello', new_string: 'goodbye' }, ctx,
      );

      if (localResult.type === 'edit_file' && wasmResult.type === 'edit_file') {
        expect(localResult.edited).toBe(true);
        expect(wasmResult.edited).toBe(true);
      }
      expect(readFileSync(join(workspace, 'edit-local.txt'), 'utf-8')).toBe('goodbye world');
      expect(readFileSync(join(workspace, 'edit-wasm.txt'), 'utf-8')).toBe('goodbye world');
    });

    test('both return error when old_string not found', async () => {
      writeFileSync(join(workspace, 'notfound-local.txt'), 'content');
      writeFileSync(join(workspace, 'notfound-wasm.txt'), 'content');

      const localResult = await local.execute(
        { type: 'edit_file', path: 'notfound-local.txt', old_string: 'missing', new_string: 'x' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'edit_file', path: 'notfound-wasm.txt', old_string: 'missing', new_string: 'x' }, ctx,
      );

      if (localResult.type === 'edit_file' && wasmResult.type === 'edit_file') {
        expect(localResult.error).toBeDefined();
        expect(wasmResult.error).toBeDefined();
        // Both should mention "old_string not found"
        expect(localResult.error).toMatch(/old_string not found/i);
        expect(wasmResult.error).toMatch(/old_string not found/i);
      }
    });

    test('both return error for missing file', async () => {
      const localResult = await local.execute(
        { type: 'edit_file', path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ctx,
      );
      const wasmResult = await wasm.execute(
        { type: 'edit_file', path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ctx,
      );

      if (localResult.type === 'edit_file' && wasmResult.type === 'edit_file') {
        expect(localResult.error).toBeDefined();
        expect(wasmResult.error).toBeDefined();
      }
    });
  });

  // ── bash ──

  describe('bash', () => {
    test('both return same output for simple commands', async () => {
      const { local: l, wasm: w } = await runBoth({ type: 'bash', command: 'echo parity-check' });
      if (l.type === 'bash' && w.type === 'bash') {
        expect(l.output).toContain('parity-check');
        expect(w.output).toContain('parity-check');
      }
    });

    test('both run in workspace directory', async () => {
      const { local: l, wasm: w } = await runBoth({ type: 'bash', command: 'pwd' });
      if (l.type === 'bash' && w.type === 'bash') {
        expect(l.output).toContain(workspace);
        expect(w.output).toContain(workspace);
      }
    });

    test('both return error info for failed commands', async () => {
      const { local: l, wasm: w } = await runBoth({ type: 'bash', command: 'ls /nonexistent-dir-xyz' });
      if (l.type === 'bash' && w.type === 'bash') {
        // Both should have output containing error info
        expect(l.output).toBeTruthy();
        expect(w.output).toBeTruthy();
      }
    });
  });

  // ── Response shape consistency ──

  describe('response shape', () => {
    test('all response types include the type field matching the request', async () => {
      writeFileSync(join(workspace, 'shape.txt'), 'data');

      const requests: SandboxToolRequest[] = [
        { type: 'read_file', path: 'shape.txt' },
        { type: 'write_file', path: 'shape-w.txt', content: 'x' },
        { type: 'edit_file', path: 'shape.txt', old_string: 'data', new_string: 'updated' },
        { type: 'bash', command: 'echo ok' },
      ];

      for (const request of requests) {
        const localResult = await local.execute(request, ctx);
        const wasmResult = await wasm.execute(request, ctx);
        expect(localResult.type).toBe(request.type);
        expect(wasmResult.type).toBe(request.type);
      }
    });
  });
});
