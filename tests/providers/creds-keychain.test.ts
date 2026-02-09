import { describe, test, expect, afterEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

const config = {
  profile: 'balanced',
  providers: { credentials: 'keychain' },
} as unknown as Config;

describe('creds-keychain', () => {
  const originalPassphrase = process.env.AX_CREDS_PASSPHRASE;

  afterEach(() => {
    if (originalPassphrase !== undefined) {
      process.env.AX_CREDS_PASSPHRASE = originalPassphrase;
    } else {
      delete process.env.AX_CREDS_PASSPHRASE;
    }
  });

  test('falls back to encrypted provider when keytar unavailable', async () => {
    // keytar is not installed in test env — should fall back
    // The fallback requires AX_CREDS_PASSPHRASE
    process.env.AX_CREDS_PASSPHRASE = 'test-passphrase';
    process.env.AX_CREDS_STORE_PATH = '/tmp/ax-keychain-test.enc';

    const { create } = await import('../../src/providers/credentials/keychain.js');
    const provider = await create(config);

    // Should have the encrypted provider interface
    expect(typeof provider.get).toBe('function');
    expect(typeof provider.set).toBe('function');
    expect(typeof provider.delete).toBe('function');
    expect(typeof provider.list).toBe('function');

    // Clean up
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync('/tmp/ax-keychain-test.enc');
    } catch { /* file may not exist */ }
  });

  test('fallback provider can get/set/delete', async () => {
    process.env.AX_CREDS_PASSPHRASE = 'test-passphrase';
    process.env.AX_CREDS_STORE_PATH = '/tmp/ax-keychain-crud.enc';

    const { create } = await import('../../src/providers/credentials/keychain.js');
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

    // Clean up
    try {
      const { unlinkSync } = await import('node:fs');
      unlinkSync('/tmp/ax-keychain-crud.enc');
    } catch { /* file may not exist */ }
  });

  test('exports create function', async () => {
    const mod = await import('../../src/providers/credentials/keychain.js');
    expect(typeof mod.create).toBe('function');
  });
});
