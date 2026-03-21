import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { create } from '../../../src/providers/credentials/database.js';
import type { CredentialProvider } from '../../../src/providers/credentials/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

// All env keys tests may set — snapshot/restore prevents cross-test leakage.
const ENV_KEYS = [
  'AX_HOME',
  'DB_CREDS_TEST_KEY',
  'MY_API_KEY',
  'KEY',
  'TO_DELETE',
  'KEY_A',
  'KEY_B',
  'KEY_C',
  'CROSS_INSTANCE',
] as const;

describe('credentials/database', () => {
  let envSnapshot: Record<string, string | undefined>;
  let provider: CredentialProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    envSnapshot = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    testHome = join(tmpdir(), `ax-creds-db-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    provider = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    for (const key of ENV_KEYS) {
      const original = envSnapshot[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  });

  test('throws when no database provider given', async () => {
    await expect(create(config, 'database'))
      .rejects.toThrow('credentials/database requires a database provider');
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
    process.env.DB_CREDS_TEST_KEY = 'from-env';
    const value = await provider.get('DB_CREDS_TEST_KEY');
    expect(value).toBe('from-env');
  });

  test('falls back to process.env with uppercase lookup', async () => {
    process.env.DB_CREDS_TEST_KEY = 'from-env-upper';
    const value = await provider.get('db_creds_test_key');
    expect(value).toBe('from-env-upper');
  });

  test('credential store value takes precedence over process.env', async () => {
    process.env.DB_CREDS_TEST_KEY = 'from-env';
    await provider.set('DB_CREDS_TEST_KEY', 'from-store');
    const value = await provider.get('DB_CREDS_TEST_KEY');
    expect(value).toBe('from-store');
  });

  test('set overwrites existing value (upsert)', async () => {
    await provider.set('KEY', 'v1');
    await provider.set('KEY', 'v2');
    expect(await provider.get('KEY')).toBe('v2');
  });

  test('concurrent set does not throw (atomic upsert)', async () => {
    await Promise.all([
      provider.set('KEY', 'a'),
      provider.set('KEY', 'b'),
    ]);
    const value = await provider.get('KEY');
    expect(value === 'a' || value === 'b').toBe(true);
  });

  test('delete removes a credential', async () => {
    await provider.set('TO_DELETE', 'value');
    await provider.delete('TO_DELETE');
    expect(await provider.get('TO_DELETE')).toBeNull();
  });

  test('delete of non-existent key does not throw', async () => {
    await expect(provider.delete('NOPE')).resolves.toBeUndefined();
  });

  test('list returns all stored keys', async () => {
    await provider.set('KEY_A', 'a');
    await provider.set('KEY_B', 'b');
    const keys = await provider.list();
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('list returns empty array when no credentials stored', async () => {
    expect(await provider.list()).toEqual([]);
  });

  test('set also updates process.env', async () => {
    await provider.set('DB_CREDS_TEST_KEY', 'via-set');
    expect(process.env.DB_CREDS_TEST_KEY).toBe('via-set');
  });

  test('persists across database connections', async () => {
    await provider.set('CROSS_INSTANCE', 'value-123');
    await database.close();

    const database2 = await createSqliteDb(config);
    try {
      const provider2 = await create(config, 'database', { database: database2 });
      expect(await provider2.get('CROSS_INSTANCE')).toBe('value-123');
    } finally {
      await database2.close();
    }
  });

  test('scoped set and get are isolated from each other', async () => {
    await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
    await provider.set('MY_API_KEY', 'user-a-value', 'user:main:alice');

    expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
    expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBe('user-a-value');
    expect(await provider.get('MY_API_KEY', 'user:main:bob')).toBeNull();
  });

  test('scoped list only returns keys for that scope', async () => {
    await provider.set('KEY_A', 'a', 'agent:main');
    await provider.set('KEY_B', 'b', 'user:main:alice');
    await provider.set('KEY_C', 'c', 'user:main:alice');

    const agentKeys = await provider.list('agent:main');
    const aliceKeys = await provider.list('user:main:alice');

    expect(agentKeys).toContain('KEY_A');
    expect(agentKeys).not.toContain('KEY_B');
    expect(aliceKeys).toContain('KEY_B');
    expect(aliceKeys).toContain('KEY_C');
    expect(aliceKeys).not.toContain('KEY_A');
  });

  test('scoped delete does not affect other scopes', async () => {
    await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
    await provider.set('MY_API_KEY', 'user-value', 'user:main:alice');

    await provider.delete('MY_API_KEY', 'user:main:alice');

    expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
    expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBeNull();
  });
});
