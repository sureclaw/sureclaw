import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { diffScope } from '../../src/agent/workspace.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('diffScope', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ax-diff-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('detects added files against empty snapshot', () => {
    const dir = join(tmpDir, 'scope');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'new.txt'), 'hello');
    const changes = diffScope(dir, new Map());
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('added');
    expect(changes[0].path).toBe('new.txt');
  });

  test('detects deleted files', () => {
    const dir = join(tmpDir, 'scope2');
    mkdirSync(dir, { recursive: true });
    const baseHashes = new Map([['gone.txt', 'abc123']]);
    const changes = diffScope(dir, baseHashes);
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe('deleted');
    expect(changes[0].path).toBe('gone.txt');
  });

  test('returns empty when nothing changed', () => {
    const dir = join(tmpDir, 'scope3');
    mkdirSync(dir, { recursive: true });
    const changes = diffScope(dir, new Map());
    expect(changes).toHaveLength(0);
  });
});
