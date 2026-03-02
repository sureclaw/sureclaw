import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../../src/types.js';

const config = {
  profile: 'balanced',
  providers: { credentials: 'keychain' },
} as unknown as Config;

describe('creds-keychain', () => {
  let testDir: string;
  const originalYamlPath = process.env.AX_CREDS_YAML_PATH;

  afterEach(() => {
    if (testDir) {
      try { rmSync(testDir, { recursive: true }); } catch {}
    }
    if (originalYamlPath !== undefined) {
      process.env.AX_CREDS_YAML_PATH = originalYamlPath;
    } else {
      delete process.env.AX_CREDS_YAML_PATH;
    }
  });

  function setupTestDir(): string {
    testDir = join(tmpdir(), `ax-keychain-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    process.env.AX_CREDS_YAML_PATH = join(testDir, 'credentials.yaml');
    return testDir;
  }

  test('falls back to plaintext provider when keytar unavailable', async () => {
    setupTestDir();

    const { create } = await import('../../../src/providers/credentials/keychain.js');
    const provider = await create(config);

    // Should have the plaintext provider interface
    expect(typeof provider.get).toBe('function');
    expect(typeof provider.set).toBe('function');
    expect(typeof provider.delete).toBe('function');
    expect(typeof provider.list).toBe('function');
  });

  test('fallback provider can get/set/delete', async () => {
    setupTestDir();

    const { create } = await import('../../../src/providers/credentials/keychain.js');
    const provider = await create(config);

    // Set and get
    await provider.set('TEST_SERVICE', 'secret-value');
    const value = await provider.get('TEST_SERVICE');
    expect(value).toBe('secret-value');

    // List
    const keys = await provider.list();
    expect(keys).toContain('TEST_SERVICE');

    // Delete
    await provider.delete('TEST_SERVICE');
    const afterDelete = await provider.get('TEST_SERVICE');
    expect(afterDelete).toBeNull();
  });

  test('fallback provider falls back to process.env on get', async () => {
    setupTestDir();

    const { create } = await import('../../../src/providers/credentials/keychain.js');
    const provider = await create(config);

    process.env.KEYCHAIN_FALLBACK_TEST = 'env-value';
    expect(await provider.get('KEYCHAIN_FALLBACK_TEST')).toBe('env-value');
    delete process.env.KEYCHAIN_FALLBACK_TEST;
  });

  test('exports create function', async () => {
    const mod = await import('../../../src/providers/credentials/keychain.js');
    expect(typeof mod.create).toBe('function');
  });
});
