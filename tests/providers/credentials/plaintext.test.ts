import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../src/providers/credentials/plaintext.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('creds-plaintext provider', () => {
  let provider: CredentialProvider;
  let testDir: string;
  let yamlPath: string;
  const originalYamlPath = process.env.AX_CREDS_YAML_PATH;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ax-creds-plaintext-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    yamlPath = join(testDir, 'credentials.yaml');
    process.env.AX_CREDS_YAML_PATH = yamlPath;
    provider = await create(config);
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch {}
    if (originalYamlPath !== undefined) {
      process.env.AX_CREDS_YAML_PATH = originalYamlPath;
    } else {
      delete process.env.AX_CREDS_YAML_PATH;
    }
    // Clean up any test env vars we set
    delete process.env.PLAINTEXT_TEST_KEY;
  });

  test('set and get a credential', async () => {
    await provider.set('MY_API_KEY', 'sk-test-123');
    const value = await provider.get('MY_API_KEY');
    expect(value).toBe('sk-test-123');
  });

  test('returns null for non-existent key', async () => {
    expect(await provider.get('NONEXISTENT_KEY_XYZ')).toBeNull();
  });

  test('falls back to process.env on get', async () => {
    process.env.PLAINTEXT_TEST_KEY = 'from-env';
    const value = await provider.get('PLAINTEXT_TEST_KEY');
    expect(value).toBe('from-env');
  });

  test('falls back to process.env with uppercase lookup', async () => {
    process.env.PLAINTEXT_TEST_KEY = 'from-env-upper';
    const value = await provider.get('plaintext_test_key');
    expect(value).toBe('from-env-upper');
  });

  test('credential store value takes precedence over process.env', async () => {
    process.env.PLAINTEXT_TEST_KEY = 'from-env';
    await provider.set('PLAINTEXT_TEST_KEY', 'from-store');
    const value = await provider.get('PLAINTEXT_TEST_KEY');
    expect(value).toBe('from-store');
  });

  test('delete removes a credential', async () => {
    await provider.set('TO_DELETE', 'value');
    await provider.delete('TO_DELETE');
    expect(await provider.get('TO_DELETE')).toBeNull();
  });

  test('list returns all stored keys', async () => {
    await provider.set('KEY_A', 'a');
    await provider.set('KEY_B', 'b');
    const keys = await provider.list();
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('persists as YAML file', async () => {
    await provider.set('PERSIST_KEY', 'persist-value');
    const raw = readFileSync(yamlPath, 'utf-8');
    expect(raw).toContain('PERSIST_KEY');
    expect(raw).toContain('persist-value');
  });

  test('persists across provider instances', async () => {
    await provider.set('CROSS_INSTANCE', 'value-123');
    const provider2 = await create(config);
    expect(await provider2.get('CROSS_INSTANCE')).toBe('value-123');
  });

  test('set also updates process.env', async () => {
    await provider.set('PLAINTEXT_TEST_KEY', 'via-set');
    expect(process.env.PLAINTEXT_TEST_KEY).toBe('via-set');
  });

  test('works when credentials file does not exist yet', async () => {
    // Fresh provider with no file — should not throw
    const freshDir = join(tmpdir(), `ax-creds-fresh-${randomUUID()}`);
    process.env.AX_CREDS_YAML_PATH = join(freshDir, 'credentials.yaml');
    const fresh = await create(config);
    expect(await fresh.list()).toEqual([]);
    await fresh.set('NEW_KEY', 'new-value');
    expect(await fresh.get('NEW_KEY')).toBe('new-value');
    try { rmSync(freshDir, { recursive: true }); } catch {}
  });
});
