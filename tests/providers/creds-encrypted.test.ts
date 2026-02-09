import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/credentials/encrypted.js';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { CredentialProvider, Config } from '../../src/providers/types.js';

const config = {} as Config;
const PASSPHRASE = 'test-passphrase-for-unit-tests';

describe('creds-encrypted', () => {
  let creds: CredentialProvider;
  let testDir: string;
  let storePath: string;
  const originalEnv = process.env.AX_CREDS_PASSPHRASE;
  const originalStorePath = process.env.AX_CREDS_STORE_PATH;

  beforeEach(async () => {
    testDir = join(tmpdir(), `ax-creds-test-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    storePath = join(testDir, 'credentials.enc');
    process.env.AX_CREDS_STORE_PATH = storePath;
    process.env.AX_CREDS_PASSPHRASE = PASSPHRASE;
    creds = await create(config);
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch {}
    if (originalEnv !== undefined) {
      process.env.AX_CREDS_PASSPHRASE = originalEnv;
    } else {
      delete process.env.AX_CREDS_PASSPHRASE;
    }
    if (originalStorePath !== undefined) {
      process.env.AX_CREDS_STORE_PATH = originalStorePath;
    } else {
      delete process.env.AX_CREDS_STORE_PATH;
    }
  });

  test('throws without passphrase env var', async () => {
    delete process.env.AX_CREDS_PASSPHRASE;
    await expect(create(config)).rejects.toThrow('AX_CREDS_PASSPHRASE');
  });

  test('set and get a credential', async () => {
    await creds.set('ANTHROPIC_API_KEY', 'sk-ant-test-123');
    const value = await creds.get('ANTHROPIC_API_KEY');
    expect(value).toBe('sk-ant-test-123');
  });

  test('returns null for non-existent credential', async () => {
    const value = await creds.get('NONEXISTENT');
    expect(value).toBeNull();
  });

  test('persists across instances', async () => {
    await creds.set('MY_KEY', 'my-value');

    // Create a new instance and verify it can read the value
    const creds2 = await create(config);
    const value = await creds2.get('MY_KEY');
    expect(value).toBe('my-value');
  });

  test('delete removes a credential', async () => {
    await creds.set('TO_DELETE', 'value');
    await creds.delete('TO_DELETE');
    const value = await creds.get('TO_DELETE');
    expect(value).toBeNull();
  });

  test('list returns all credential keys', async () => {
    await creds.set('KEY_A', 'a');
    await creds.set('KEY_B', 'b');
    const keys = await creds.list();
    expect(keys).toContain('KEY_A');
    expect(keys).toContain('KEY_B');
  });

  test('wrong passphrase cannot read credentials', async () => {
    await creds.set('SECRET', 'value');

    // Change passphrase
    process.env.AX_CREDS_PASSPHRASE = 'wrong-passphrase';
    const creds2 = await create(config);

    // Should fail to decrypt — returns empty store or throws
    const value = await creds2.get('SECRET');
    expect(value).toBeNull();
  });

  test('encrypted file is not plaintext', async () => {
    await creds.set('SECRET', 'super-secret-value');
    const raw = readFileSync(storePath, 'utf-8');
    expect(raw).not.toContain('super-secret-value');
    expect(raw).not.toContain('SECRET');
    // Should be valid JSON with encryption fields
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('salt');
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('tag');
    expect(parsed).toHaveProperty('data');
  });
});
