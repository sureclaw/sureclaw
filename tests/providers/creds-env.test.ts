import { describe, test, expect, beforeEach } from 'vitest';
import { create } from '../../src/providers/creds-env.js';
import type { Config } from '../../src/providers/types.js';

const config = {} as Config;

describe('creds-env provider', () => {
  let provider: Awaited<ReturnType<typeof create>>;

  beforeEach(async () => {
    provider = await create(config);
  });

  test('reads from process.env', async () => {
    process.env['TEST_CRED'] = 'secret123';
    expect(await provider.get('test_cred')).toBe('secret123');
    delete process.env['TEST_CRED'];
  });

  test('returns null for missing keys', async () => {
    expect(await provider.get('nonexistent_key_xyz')).toBeNull();
  });

  test('set throws (read-only)', async () => {
    await expect(provider.set('foo', 'bar')).rejects.toThrow('read-only');
  });

  test('delete throws (read-only)', async () => {
    await expect(provider.delete('foo')).rejects.toThrow('read-only');
  });

  test('list returns env keys', async () => {
    const keys = await provider.list();
    expect(Array.isArray(keys)).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
  });
});
