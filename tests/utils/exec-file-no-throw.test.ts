/**
 * Tests for execFileNoThrow — especially the optional `opts` for stdin,
 * env, cwd. These are used by the workspace provider to drive git plumbing
 * commands (`git hash-object -w --stdin`, commit-tree with author env vars).
 */
import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileNoThrow } from '../../src/utils/execFileNoThrow.js';

describe('execFileNoThrow', () => {
  const dirs: string[] = [];
  function mkTmp(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  test('runs successfully without opts', async () => {
    const r = await execFileNoThrow('node', ['-e', 'console.log("ok")']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  test('captures non-zero exit without throwing', async () => {
    const r = await execFileNoThrow('node', ['-e', 'process.exit(42)']);
    expect(r.status).toBe(42);
  });

  test('opts.input pipes stdin', async () => {
    const r = await execFileNoThrow('node', ['-e', `
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', d => buf += d);
      process.stdin.on('end', () => process.stdout.write('got:' + buf));
    `], { input: 'hello' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('got:hello');
  });

  test('opts.input accepts Buffer', async () => {
    const r = await execFileNoThrow('node', ['-e', `
      const chunks = [];
      process.stdin.on('data', d => chunks.push(d));
      process.stdin.on('end', () => {
        const buf = Buffer.concat(chunks);
        process.stdout.write('len=' + buf.length);
      });
    `], { input: Buffer.from([0, 1, 2, 3, 4]) });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('len=5');
  });

  test('opts.env overrides environment', async () => {
    const r = await execFileNoThrow('node', ['-e', 'process.stdout.write(process.env.MY_VAR || "")'], {
      env: { ...process.env, MY_VAR: 'custom' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('custom');
  });

  test('does not crash when child exits before reading all stdin (EPIPE)', async () => {
    // `false` exits 1 without consuming stdin. A large input forces the
    // write to block past the child's exit so Node's stdin stream emits
    // 'error' (EPIPE/ECONNRESET). Without an 'error' listener on child.stdin
    // this would bubble as an unhandled stream error and crash the process.
    const bigInput = Buffer.alloc(1024 * 1024, 0x41); // 1MB of 'A'
    const r = await execFileNoThrow('false', [], { input: bigInput });
    expect(r.status).toBe(1);
  });

  test('opts.cwd runs in given directory', async () => {
    const dir = mkTmp('cwd');
    writeFileSync(join(dir, 'marker.txt'), '');
    const r = await execFileNoThrow('node', ['-e', `
      const fs = require('fs');
      process.stdout.write(fs.existsSync('marker.txt') ? 'yes' : 'no');
    `], { cwd: dir });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('yes');
  });
});
