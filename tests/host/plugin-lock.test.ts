import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readPluginLock,
  writePluginLock,
  addPluginToLock,
  removePluginFromLock,
  computeIntegrity,
  verifyPluginIntegrity,
  type PluginLockFile,
} from '../../src/host/plugin-lock.js';

describe('Plugin lock file', () => {
  let tmpDir: string;
  let lockPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-plugin-lock-test-'));
    lockPath = join(tmpDir, 'plugins.lock');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('readPluginLock returns empty state when file does not exist', () => {
    const lock = readPluginLock(lockPath);
    expect(lock.version).toBe(1);
    expect(Object.keys(lock.plugins)).toHaveLength(0);
  });

  test('writePluginLock and readPluginLock round-trip', () => {
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/provider': {
          version: '1.0.0',
          integrity: 'sha512-abc==',
          kind: 'memory',
          name: 'test',
          main: 'index.js',
          capabilities: {
            network: ['localhost:5432'],
            filesystem: 'none',
            credentials: ['DB_URL'],
          },
          installedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    };

    writePluginLock(lock, lockPath);
    const read = readPluginLock(lockPath);

    expect(read.version).toBe(1);
    expect(read.plugins['@test/provider']).toBeDefined();
    expect(read.plugins['@test/provider'].version).toBe('1.0.0');
    expect(read.plugins['@test/provider'].kind).toBe('memory');
    expect(read.plugins['@test/provider'].capabilities.network).toEqual(['localhost:5432']);
  });

  test('addPluginToLock creates lock file and adds entry', () => {
    const manifest = {
      name: '@community/provider-memory-postgres',
      ax_provider: { kind: 'memory' as const, name: 'postgres' },
      capabilities: {
        network: ['localhost:5432'],
        filesystem: 'none' as const,
        credentials: ['POSTGRES_URL'],
      },
      main: 'index.js',
    };

    addPluginToLock(manifest, 'sha512-abc123==', lockPath);

    const lock = readPluginLock(lockPath);
    const entry = lock.plugins['@community/provider-memory-postgres'];
    expect(entry).toBeDefined();
    expect(entry.kind).toBe('memory');
    expect(entry.name).toBe('postgres');
    expect(entry.integrity).toBe('sha512-abc123==');
    expect(entry.capabilities.network).toEqual(['localhost:5432']);
    expect(entry.installedAt).toBeDefined();
  });

  test('addPluginToLock appends to existing lock file', () => {
    const manifest1 = {
      name: '@test/plugin-a',
      ax_provider: { kind: 'memory' as const, name: 'a' },
      capabilities: { network: [] as string[], filesystem: 'none' as const, credentials: [] as string[] },
      main: 'index.js',
    };
    const manifest2 = {
      name: '@test/plugin-b',
      ax_provider: { kind: 'scanner' as const, name: 'b' },
      capabilities: { network: [] as string[], filesystem: 'none' as const, credentials: [] as string[] },
      main: 'index.js',
    };

    addPluginToLock(manifest1, 'sha512-aaa==', lockPath);
    addPluginToLock(manifest2, 'sha512-bbb==', lockPath);

    const lock = readPluginLock(lockPath);
    expect(Object.keys(lock.plugins)).toHaveLength(2);
    expect(lock.plugins['@test/plugin-a']).toBeDefined();
    expect(lock.plugins['@test/plugin-b']).toBeDefined();
  });

  test('removePluginFromLock removes entry', () => {
    const manifest = {
      name: '@test/removable',
      ax_provider: { kind: 'memory' as const, name: 'removable' },
      capabilities: { network: [] as string[], filesystem: 'none' as const, credentials: [] as string[] },
      main: 'index.js',
    };

    addPluginToLock(manifest, 'sha512-xxx==', lockPath);
    expect(readPluginLock(lockPath).plugins['@test/removable']).toBeDefined();

    const removed = removePluginFromLock('@test/removable', lockPath);
    expect(removed).toBe(true);
    expect(readPluginLock(lockPath).plugins['@test/removable']).toBeUndefined();
  });

  test('removePluginFromLock returns false for unknown package', () => {
    const removed = removePluginFromLock('@test/nonexistent', lockPath);
    expect(removed).toBe(false);
  });

  test('computeIntegrity produces sha512 hash', () => {
    const hash = computeIntegrity('hello world');
    expect(hash).toMatch(/^sha512-[A-Za-z0-9+/=]+$/);
  });

  test('computeIntegrity is deterministic', () => {
    const hash1 = computeIntegrity('test content');
    const hash2 = computeIntegrity('test content');
    expect(hash1).toBe(hash2);
  });

  test('computeIntegrity differs for different content', () => {
    const hash1 = computeIntegrity('content a');
    const hash2 = computeIntegrity('content b');
    expect(hash1).not.toBe(hash2);
  });

  test('verifyPluginIntegrity detects matching content', () => {
    const pluginContent = 'module.exports = { create() {} }';
    const integrity = computeIntegrity(pluginContent);

    // Create a fake installed plugin
    const installDir = join(tmpDir, 'installed');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'index.js'), pluginContent);

    // Add to lock
    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/plugin': {
          version: '1.0.0',
          integrity,
          kind: 'memory',
          name: 'test',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    expect(verifyPluginIntegrity('@test/plugin', installDir, lockPath)).toBe(true);
  });

  test('verifyPluginIntegrity detects tampered content', () => {
    const originalContent = 'module.exports = { create() {} }';
    const integrity = computeIntegrity(originalContent);

    const installDir = join(tmpDir, 'tampered');
    mkdirSync(installDir, { recursive: true });
    writeFileSync(join(installDir, 'index.js'), 'TAMPERED CONTENT');

    const lock: PluginLockFile = {
      version: 1,
      plugins: {
        '@test/plugin': {
          version: '1.0.0',
          integrity,
          kind: 'memory',
          name: 'test',
          main: 'index.js',
          capabilities: { network: [], filesystem: 'none', credentials: [] },
          installedAt: new Date().toISOString(),
        },
      },
    };
    writePluginLock(lock, lockPath);

    expect(verifyPluginIntegrity('@test/plugin', installDir, lockPath)).toBe(false);
  });

  test('verifyPluginIntegrity returns false for unknown package', () => {
    expect(verifyPluginIntegrity('@test/unknown', tmpDir, lockPath)).toBe(false);
  });

  test('readPluginLock rejects unsupported version', () => {
    writeFileSync(lockPath, JSON.stringify({ version: 99, plugins: {} }));
    expect(() => readPluginLock(lockPath)).toThrow('Unsupported plugins.lock version');
  });
});
