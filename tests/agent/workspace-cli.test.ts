import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { provisionWorkspace, releaseWorkspace, computeCacheKey, provisionScope, diffScope } from '../../src/agent/workspace.js';
import { mkdirSync, rmSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('workspace provisioning (migrated)', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = join(tmpdir(), `ax-ws-test-${randomUUID()}`);
    mkdirSync(testRoot, { recursive: true });
    // Unset GCS bucket to test non-cache paths
    delete process.env.WORKSPACE_CACHE_BUCKET;
  });

  afterEach(() => {
    try { rmSync(testRoot, { recursive: true, force: true }); } catch {}
  });

  test('computeCacheKey produces deterministic hash', () => {
    const key1 = computeCacheKey('https://github.com/org/repo.git', 'main');
    const key2 = computeCacheKey('https://github.com/org/repo.git', 'main');
    const key3 = computeCacheKey('https://github.com/org/repo.git', 'develop');

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1.length).toBe(16);
    expect(key1).toMatch(/^[a-f0-9]{16}$/);
  });

  test('provisions empty workspace when no gitUrl', async () => {
    const result = await provisionWorkspace(testRoot, 'session-1');

    expect(result.source).toBe('empty');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(existsSync(result.path)).toBe(true);
    expect(result.path).toContain('session-1');
  });

  test('provisions empty workspace with config but no gitUrl', async () => {
    const result = await provisionWorkspace(testRoot, 'session-2', {});

    expect(result.source).toBe('empty');
    expect(existsSync(result.path)).toBe(true);
  });

  test('workspace path is within root', async () => {
    const result = await provisionWorkspace(testRoot, 'my-session');

    expect(result.path.startsWith(testRoot)).toBe(true);
  });

  test('releaseWorkspace cleans up directory', async () => {
    const result = await provisionWorkspace(testRoot, 'cleanup-test');
    writeFileSync(join(result.path, 'test.txt'), 'hello');
    expect(existsSync(result.path)).toBe(true);

    await releaseWorkspace(result.path);

    expect(existsSync(result.path)).toBe(false);
  });

  test('releaseWorkspace is safe on missing directory', async () => {
    await releaseWorkspace(join(testRoot, 'nonexistent-path'));
  });

  test('provisions separate workspaces for different sessions', async () => {
    const r1 = await provisionWorkspace(testRoot, 'session-a');
    const r2 = await provisionWorkspace(testRoot, 'session-b');

    expect(r1.path).not.toBe(r2.path);
    expect(existsSync(r1.path)).toBe(true);
    expect(existsSync(r2.path)).toBe(true);
  });
});

describe('provisionScope (migrated)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ax-scope-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  test('creates mount directory', async () => {
    const mountPath = join(tmpDir, 'agent');
    const result = await provisionScope(mountPath, 'agent/test/', true);
    expect(existsSync(mountPath)).toBe(true);
    expect(result.source).toBe('empty');
  });

  test('returns empty hashes when no GCS bucket', async () => {
    const mountPath = join(tmpDir, 'user');
    const result = await provisionScope(mountPath, 'user/alice/', false);
    expect(result.hashes.size).toBe(0);
    expect(result.fileCount).toBe(0);
  });
});

describe('diffScope (migrated)', () => {
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
