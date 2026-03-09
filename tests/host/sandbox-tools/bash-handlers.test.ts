/**
 * Phase 2 tests: Native bash command handlers.
 *
 * Tests verify that native handlers produce correct output for each
 * allowlisted command. Handlers that use the hostcall API for file access
 * are tested with real filesystem fixtures.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getNativeHandler,
  execValidated,
} from '../../../src/host/sandbox-tools/bash-handlers.js';
import type {
  BashHandlerContext,
  HostcallsForBash,
} from '../../../src/host/sandbox-tools/bash-handlers.js';
import type { ToolInvocationContext } from '../../../src/host/sandbox-tools/wasm-executor.js';
import { createWasmExecutor } from '../../../src/host/sandbox-tools/wasm-executor.js';
import type { SandboxExecutionContext } from '../../../src/host/sandbox-tools/types.js';
import { safePath } from '../../../src/utils/safe-path.js';

// ── Test helpers ──

function createTestContext(workspace: string): BashHandlerContext {
  const invocationCtx: ToolInvocationContext = {
    invocationId: 'test-inv-1',
    sessionId: 'test-session',
    module: 'bash-readonly',
    permissions: {
      fsRead: ['*'],
      fsWrite: [],
      maxBytesRead: 10 * 1024 * 1024,
      maxBytesWrite: 0,
    },
    limits: {
      maxMemoryMb: 256,
      maxTimeMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    },
    deadlineMs: Date.now() + 30_000,
  };

  // Real hostcalls that go through the filesystem with safePath validation
  const hostcalls: HostcallsForBash = {
    fsRead(path: string) {
      const segments = path.split(/[/\\]/).filter(s => Boolean(s) && s !== '.');
      const abs = segments.length === 0 ? workspace : safePath(workspace, ...segments);
      return { content: readFileSync(abs, 'utf-8') };
    },
    fsList(path: string, _recursive?: boolean, maxEntries = 10_000) {
      const segments = path.split(/[/\\]/).filter(s => Boolean(s) && s !== '.');
      const abs = segments.length === 0 ? workspace : safePath(workspace, ...segments);
      const items = readdirSync(abs, { withFileTypes: true });
      const entries: Array<{ name: string; type: string; size: number }> = [];
      for (const item of items) {
        if (entries.length >= maxEntries) break;
        try {
          const s = statSync(`${abs}/${item.name}`);
          entries.push({
            name: item.name,
            type: item.isDirectory() ? 'directory' : 'file',
            size: s.size,
          });
        } catch {
          // skip inaccessible
        }
      }
      return { entries };
    },
  };

  return { workspace, invocationCtx, hostcalls };
}

describe('BashHandlers', () => {
  let workspace: string;
  let ctx: BashHandlerContext;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'bash-handlers-test-'));
    ctx = createTestContext(workspace);
  });

  afterEach(() => {
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  // ── Pure handlers ──

  describe('pwd', () => {
    test('returns resolved workspace path with trailing newline', () => {
      const handler = getNativeHandler('pwd')!;
      expect(handler).toBeDefined();
      const result = handler([], ctx);
      // pwd resolves symlinks (e.g., macOS /var -> /private/var)
      const resolvedWorkspace = realpathSync(workspace);
      expect(result.output).toBe(resolvedWorkspace + '\n');
      expect(result.exitCode).toBe(0);
    });

    test('ignores arguments', () => {
      const handler = getNativeHandler('pwd')!;
      const result = handler(['-L', '-P'], ctx);
      const resolvedWorkspace = realpathSync(workspace);
      expect(result.output).toBe(resolvedWorkspace + '\n');
    });
  });

  describe('echo', () => {
    test('outputs arguments joined by spaces with newline', () => {
      const handler = getNativeHandler('echo')!;
      const result = handler(['hello', 'world'], ctx);
      expect(result.output).toBe('hello world\n');
      expect(result.exitCode).toBe(0);
    });

    test('empty arguments produce just a newline', () => {
      const handler = getNativeHandler('echo')!;
      const result = handler([], ctx);
      expect(result.output).toBe('\n');
    });

    test('-n suppresses trailing newline', () => {
      const handler = getNativeHandler('echo')!;
      const result = handler(['-n', 'hello'], ctx);
      expect(result.output).toBe('hello');
    });

    test('single argument', () => {
      const handler = getNativeHandler('echo')!;
      const result = handler(['test-string'], ctx);
      expect(result.output).toBe('test-string\n');
    });
  });

  describe('basename', () => {
    test('extracts filename from path', () => {
      const handler = getNativeHandler('basename')!;
      const result = handler(['/foo/bar/baz.txt'], ctx);
      expect(result.output).toBe('baz.txt\n');
      expect(result.exitCode).toBe(0);
    });

    test('strips suffix when provided', () => {
      const handler = getNativeHandler('basename')!;
      const result = handler(['/foo/bar.txt', '.txt'], ctx);
      expect(result.output).toBe('bar\n');
    });

    test('missing operand returns error', () => {
      const handler = getNativeHandler('basename')!;
      const result = handler([], ctx);
      expect(result.exitCode).toBe(1);
    });

    test('handles just filename', () => {
      const handler = getNativeHandler('basename')!;
      const result = handler(['file.ts'], ctx);
      expect(result.output).toBe('file.ts\n');
    });
  });

  describe('dirname', () => {
    test('extracts directory from path', () => {
      const handler = getNativeHandler('dirname')!;
      const result = handler(['/foo/bar/baz.txt'], ctx);
      expect(result.output).toBe('/foo/bar\n');
      expect(result.exitCode).toBe(0);
    });

    test('returns . for bare filename', () => {
      const handler = getNativeHandler('dirname')!;
      const result = handler(['file.txt'], ctx);
      expect(result.output).toBe('.\n');
    });

    test('missing operand returns error', () => {
      const handler = getNativeHandler('dirname')!;
      const result = handler([], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  // ── FS-based handlers ──

  describe('cat', () => {
    test('reads file content exactly', () => {
      writeFileSync(join(workspace, 'hello.txt'), 'hello world\n');
      const handler = getNativeHandler('cat')!;
      const result = handler(['hello.txt'], ctx);
      expect(result.output).toBe('hello world\n');
      expect(result.exitCode).toBe(0);
    });

    test('concatenates multiple files', () => {
      writeFileSync(join(workspace, 'a.txt'), 'aaa\n');
      writeFileSync(join(workspace, 'b.txt'), 'bbb\n');
      const handler = getNativeHandler('cat')!;
      const result = handler(['a.txt', 'b.txt'], ctx);
      expect(result.output).toBe('aaa\nbbb\n');
    });

    test('preserves files without trailing newline', () => {
      writeFileSync(join(workspace, 'no-nl.txt'), 'no newline');
      const handler = getNativeHandler('cat')!;
      const result = handler(['no-nl.txt'], ctx);
      expect(result.output).toBe('no newline');
    });

    test('handles empty file', () => {
      writeFileSync(join(workspace, 'empty.txt'), '');
      const handler = getNativeHandler('cat')!;
      const result = handler(['empty.txt'], ctx);
      expect(result.output).toBe('');
    });

    test('returns error for missing file', () => {
      const handler = getNativeHandler('cat')!;
      const result = handler(['missing.txt'], ctx);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain('cat:');
    });

    test('-n shows line numbers', () => {
      writeFileSync(join(workspace, 'numbered.txt'), 'line1\nline2\nline3\n');
      const handler = getNativeHandler('cat')!;
      const result = handler(['-n', 'numbered.txt'], ctx);
      expect(result.output).toContain('1\tline1');
      expect(result.output).toContain('2\tline2');
      expect(result.output).toContain('3\tline3');
    });
  });

  describe('head', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    test('shows first 10 lines by default', () => {
      writeFileSync(join(workspace, 'lines.txt'), content);
      const handler = getNativeHandler('head')!;
      const result = handler(['lines.txt'], ctx);
      expect(result.exitCode).toBe(0);
      const lines = result.output.trimEnd().split('\n');
      expect(lines.length).toBe(10);
      expect(lines[0]).toBe('line 1');
      expect(lines[9]).toBe('line 10');
    });

    test('-n 5 shows first 5 lines', () => {
      writeFileSync(join(workspace, 'lines.txt'), content);
      const handler = getNativeHandler('head')!;
      const result = handler(['-n', '5', 'lines.txt'], ctx);
      const lines = result.output.trimEnd().split('\n');
      expect(lines.length).toBe(5);
      expect(lines[4]).toBe('line 5');
    });

    test('-3 shows first 3 lines', () => {
      writeFileSync(join(workspace, 'lines.txt'), content);
      const handler = getNativeHandler('head')!;
      const result = handler(['-3', 'lines.txt'], ctx);
      const lines = result.output.trimEnd().split('\n');
      expect(lines.length).toBe(3);
    });

    test('file with fewer lines than count', () => {
      writeFileSync(join(workspace, 'short.txt'), 'one\ntwo\n');
      const handler = getNativeHandler('head')!;
      const result = handler(['-n', '100', 'short.txt'], ctx);
      expect(result.output).toBe('one\ntwo\n');
    });

    test('multi-file headers', () => {
      writeFileSync(join(workspace, 'a.txt'), 'aaa\n');
      writeFileSync(join(workspace, 'b.txt'), 'bbb\n');
      const handler = getNativeHandler('head')!;
      const result = handler(['a.txt', 'b.txt'], ctx);
      expect(result.output).toContain('==> a.txt <==');
      expect(result.output).toContain('==> b.txt <==');
    });

    test('missing file returns error', () => {
      const handler = getNativeHandler('head')!;
      const result = handler(['missing.txt'], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('tail', () => {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

    test('shows last 10 lines by default', () => {
      writeFileSync(join(workspace, 'lines.txt'), content);
      const handler = getNativeHandler('tail')!;
      const result = handler(['lines.txt'], ctx);
      expect(result.exitCode).toBe(0);
      const lines = result.output.trimEnd().split('\n');
      expect(lines.length).toBe(10);
      expect(lines[0]).toBe('line 11');
      expect(lines[9]).toBe('line 20');
    });

    test('-n 5 shows last 5 lines', () => {
      writeFileSync(join(workspace, 'lines.txt'), content);
      const handler = getNativeHandler('tail')!;
      const result = handler(['-n', '5', 'lines.txt'], ctx);
      const lines = result.output.trimEnd().split('\n');
      expect(lines.length).toBe(5);
      expect(lines[0]).toBe('line 16');
    });

    test('file with fewer lines than count', () => {
      writeFileSync(join(workspace, 'short.txt'), 'one\ntwo\n');
      const handler = getNativeHandler('tail')!;
      const result = handler(['-n', '100', 'short.txt'], ctx);
      expect(result.output).toBe('one\ntwo\n');
    });

    test('multi-file headers', () => {
      writeFileSync(join(workspace, 'a.txt'), 'aaa\n');
      writeFileSync(join(workspace, 'b.txt'), 'bbb\n');
      const handler = getNativeHandler('tail')!;
      const result = handler(['a.txt', 'b.txt'], ctx);
      expect(result.output).toContain('==> a.txt <==');
      expect(result.output).toContain('==> b.txt <==');
    });
  });

  describe('wc', () => {
    test('-l counts lines', () => {
      writeFileSync(join(workspace, 'lines.txt'), 'a\nb\nc\n');
      const handler = getNativeHandler('wc')!;
      const result = handler(['-l', 'lines.txt'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('3');
      expect(result.output).toContain('lines.txt');
    });

    test('-w counts words', () => {
      writeFileSync(join(workspace, 'words.txt'), 'hello world foo\n');
      const handler = getNativeHandler('wc')!;
      const result = handler(['-w', 'words.txt'], ctx);
      expect(result.output).toContain('3');
    });

    test('-c counts bytes', () => {
      writeFileSync(join(workspace, 'bytes.txt'), 'hello\n');
      const handler = getNativeHandler('wc')!;
      const result = handler(['-c', 'bytes.txt'], ctx);
      expect(result.output).toContain('6');
    });

    test('no flags shows lines, words, and bytes', () => {
      writeFileSync(join(workspace, 'all.txt'), 'hello world\n');
      const handler = getNativeHandler('wc')!;
      const result = handler(['all.txt'], ctx);
      // Should contain line count (1), word count (2), byte count (12)
      expect(result.output).toContain('1');
      expect(result.output).toContain('2');
      expect(result.output).toContain('12');
    });

    test('multiple files show totals', () => {
      writeFileSync(join(workspace, 'a.txt'), 'aaa\n');
      writeFileSync(join(workspace, 'b.txt'), 'bbb\n');
      const handler = getNativeHandler('wc')!;
      const result = handler(['-l', 'a.txt', 'b.txt'], ctx);
      expect(result.output).toContain('total');
    });

    test('missing file returns error', () => {
      const handler = getNativeHandler('wc')!;
      const result = handler(['-l', 'missing.txt'], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('ls', () => {
    test('lists files in workspace', () => {
      writeFileSync(join(workspace, 'alpha.txt'), 'a');
      writeFileSync(join(workspace, 'beta.txt'), 'b');
      const handler = getNativeHandler('ls')!;
      const result = handler([], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('alpha.txt');
      expect(result.output).toContain('beta.txt');
    });

    test('hides dotfiles by default', () => {
      writeFileSync(join(workspace, '.hidden'), 'h');
      writeFileSync(join(workspace, 'visible.txt'), 'v');
      const handler = getNativeHandler('ls')!;
      const result = handler([], ctx);
      expect(result.output).not.toContain('.hidden');
      expect(result.output).toContain('visible.txt');
    });

    test('-a shows dotfiles', () => {
      writeFileSync(join(workspace, '.hidden'), 'h');
      writeFileSync(join(workspace, 'visible.txt'), 'v');
      const handler = getNativeHandler('ls')!;
      const result = handler(['-a'], ctx);
      expect(result.output).toContain('.hidden');
      expect(result.output).toContain('visible.txt');
    });

    test('-l shows long format', () => {
      writeFileSync(join(workspace, 'file.txt'), 'content');
      const handler = getNativeHandler('ls')!;
      const result = handler(['-l'], ctx);
      expect(result.output).toContain('total');
      expect(result.output).toContain('file.txt');
    });

    test('lists subdirectory', () => {
      mkdirSync(join(workspace, 'sub'));
      writeFileSync(join(workspace, 'sub', 'child.txt'), 'c');
      const handler = getNativeHandler('ls')!;
      const result = handler(['sub'], ctx);
      expect(result.output).toContain('child.txt');
    });

    test('missing directory returns error', () => {
      const handler = getNativeHandler('ls')!;
      const result = handler(['nonexistent'], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('stat', () => {
    test('shows file info', () => {
      writeFileSync(join(workspace, 'info.txt'), 'content');
      const handler = getNativeHandler('stat')!;
      const result = handler(['info.txt'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('File: info.txt');
      expect(result.output).toContain('Size:');
    });

    test('missing file returns error', () => {
      const handler = getNativeHandler('stat')!;
      const result = handler(['missing.txt'], ctx);
      expect(result.exitCode).toBe(1);
    });

    test('missing operand returns error', () => {
      const handler = getNativeHandler('stat')!;
      const result = handler([], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  describe('realpath', () => {
    test('resolves to absolute path within workspace', () => {
      writeFileSync(join(workspace, 'real.txt'), 'content');
      const handler = getNativeHandler('realpath')!;
      const result = handler(['real.txt'], ctx);
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toContain(workspace);
    });

    test('missing operand returns error', () => {
      const handler = getNativeHandler('realpath')!;
      const result = handler([], ctx);
      expect(result.exitCode).toBe(1);
    });
  });

  // ── Handler registry ──

  describe('getNativeHandler', () => {
    test('returns handler for known commands', () => {
      const commands = ['pwd', 'echo', 'basename', 'dirname', 'cat', 'head', 'tail', 'wc', 'ls', 'stat', 'realpath'];
      for (const cmd of commands) {
        expect(getNativeHandler(cmd)).toBeDefined();
      }
    });

    test('returns undefined for binary-delegated commands', () => {
      const commands = ['rg', 'grep', 'find', 'git', 'file', 'tree', 'du', 'df'];
      for (const cmd of commands) {
        expect(getNativeHandler(cmd)).toBeUndefined();
      }
    });
  });

  // ── Validated exec ──

  describe('execValidated', () => {
    test('runs command in workspace', () => {
      const result = execValidated('pwd', ctx);
      expect(result.exitCode).toBe(0);
      // pwd resolves symlinks (e.g., macOS /var -> /private/var)
      const resolvedWorkspace = realpathSync(workspace);
      expect(result.output.trim()).toBe(resolvedWorkspace);
    });

    test('captures stderr for failed commands', () => {
      const result = execValidated('ls /nonexistent-dir-xyz-123', ctx);
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toBeTruthy();
    });
  });

  // ── Integration: WASM executor uses handlers ──

  describe('WASM executor bash integration', () => {
    let execCtx: SandboxExecutionContext;
    const executor = createWasmExecutor();

    beforeEach(() => {
      execCtx = { workspace, sessionId: 'test-session', requestId: 'test-req' };
    });

    test('pwd uses native handler', async () => {
      const result = await executor.execute({ type: 'bash', command: 'pwd' }, execCtx);
      if (result.type === 'bash') {
        const resolvedWorkspace = realpathSync(workspace);
        expect(result.output).toBe(resolvedWorkspace + '\n');
        expect(result.exitCode).toBe(0);
      }
    });

    test('echo uses native handler', async () => {
      const result = await executor.execute({ type: 'bash', command: 'echo hello world' }, execCtx);
      if (result.type === 'bash') {
        expect(result.output).toBe('hello world\n');
      }
    });

    test('cat uses native handler with hostcalls', async () => {
      writeFileSync(join(workspace, 'test.txt'), 'test content\n');
      const result = await executor.execute({ type: 'bash', command: 'cat test.txt' }, execCtx);
      if (result.type === 'bash') {
        expect(result.output).toBe('test content\n');
      }
    });

    test('head uses native handler', async () => {
      const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
      writeFileSync(join(workspace, 'many.txt'), lines);
      const result = await executor.execute({ type: 'bash', command: 'head -n 3 many.txt' }, execCtx);
      if (result.type === 'bash') {
        expect(result.output).toBe('line1\nline2\nline3\n');
      }
    });

    test('ls uses native handler', async () => {
      writeFileSync(join(workspace, 'file1.txt'), 'a');
      writeFileSync(join(workspace, 'file2.txt'), 'b');
      const result = await executor.execute({ type: 'bash', command: 'ls' }, execCtx);
      if (result.type === 'bash') {
        expect(result.output).toContain('file1.txt');
        expect(result.output).toContain('file2.txt');
      }
    });

    test('wc -l uses native handler', async () => {
      writeFileSync(join(workspace, 'count.txt'), 'a\nb\nc\n');
      const result = await executor.execute({ type: 'bash', command: 'wc -l count.txt' }, execCtx);
      if (result.type === 'bash') {
        expect(result.output).toContain('3');
      }
    });
  });
});
