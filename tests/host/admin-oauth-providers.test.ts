// tests/host/admin-oauth-providers.test.ts — Phase 6 Task 1 coverage.
//
// 1) AES-256-GCM round-trip + tamper detection.
// 2) `deriveOAuthKey` priority (env > admin-token) and malformed-env rejection.
// 3) Storage module: upsert/get/list/delete semantics — with and without
//    a client secret, confirming that `list()` NEVER leaks the secret
//    (we grep the stringified output) and that ordering is ascending by
//    provider name.
//
// In-memory SQLite via Kysely's SqliteDialect mirrors tests/host/skills/state-store.test.ts.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { randomBytes, createHash } from 'node:crypto';
import { runMigrations } from '../../src/utils/migrator.js';
import { adminOAuthMigrations } from '../../src/migrations/admin-oauth-providers.js';
import {
  createAdminOAuthProviderStore,
  decryptSecret,
  deriveOAuthKey,
  encryptSecret,
  type AdminOAuthProviderStore,
} from '../../src/host/admin-oauth-providers.js';

async function makeDb() {
  const sqliteDb = new Database(':memory:');
  const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
  const result = await runMigrations(db, adminOAuthMigrations, 'admin_oauth_migration');
  if (result.error) throw result.error;
  return {
    db,
    close: async () => { await db.destroy(); },
  };
}

describe('admin-oauth-providers crypto helpers', () => {
  it('encryptSecret + decryptSecret round-trip exactly', () => {
    const key = randomBytes(32);
    const plain = 'super-secret-value';
    const blob = encryptSecret(plain, key);
    expect(decryptSecret(blob, key)).toBe(plain);
  });

  it('decryptSecret throws when the ciphertext is tampered with', () => {
    const key = randomBytes(32);
    const blob = encryptSecret('super-secret-value', key);
    // Flip a byte inside the ciphertext (between iv and tag).
    const buf = Buffer.from(blob, 'base64');
    // iv = [0, 12), tag = [len-16, len); ciphertext = [12, len-16).
    const flipIdx = 12 + Math.floor((buf.length - 12 - 16) / 2);
    buf[flipIdx] = buf[flipIdx] ^ 0xff;
    const tampered = buf.toString('base64');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('deriveOAuthKey prefers the env var when both are provided', () => {
    const envKeyBytes = randomBytes(32);
    const envKey = envKeyBytes.toString('hex');
    const result = deriveOAuthKey('any-admin-token', envKey);
    expect(result.derivedFrom).toBe('env');
    expect(result.key.equals(envKeyBytes)).toBe(true);
  });

  it('deriveOAuthKey falls back to sha256(adminToken) when env is unset', () => {
    // Token must be at least 16 chars — see the "empty / short admin token"
    // cases below for the rejection contract.
    const token = 'a-sufficiently-long-admin-token';
    const result = deriveOAuthKey(token);
    const expected = createHash('sha256').update(token).digest();
    expect(result.derivedFrom).toBe('admin-token');
    expect(result.key.equals(expected)).toBe(true);
  });

  it('deriveOAuthKey throws on a malformed env key', () => {
    expect(() => deriveOAuthKey('a-sufficiently-long-admin-token', 'abc')).toThrow(/32 hex/);
  });

  it('deriveOAuthKey throws when admin token is empty and env is unset', () => {
    // sha256('') is a world-known constant — refusing to derive from it
    // prevents two unconfigured installs from sharing the same at-rest key.
    expect(() => deriveOAuthKey('', undefined)).toThrow(/at least 16/);
  });

  it('deriveOAuthKey throws when admin token is shorter than 16 chars', () => {
    expect(() => deriveOAuthKey('tooshort', undefined)).toThrow(/at least 16/);
  });

  it('deriveOAuthKey accepts a 16+ char admin token and returns a 32-byte key', () => {
    const token = 'a'.repeat(16);
    const result = deriveOAuthKey(token, undefined);
    expect(result.derivedFrom).toBe('admin-token');
    expect(result.key.length).toBe(32);
    const expected = createHash('sha256').update(token).digest();
    expect(result.key.equals(expected)).toBe(true);
  });
});

describe('AdminOAuthProviderStore', () => {
  let handles: Array<{ close: () => Promise<void> }> = [];
  let store: AdminOAuthProviderStore;
  let db: Kysely<any>;
  let key: Buffer;

  beforeEach(async () => {
    const h = await makeDb();
    handles.push(h);
    db = h.db;
    key = randomBytes(32);
    store = createAdminOAuthProviderStore(h.db, key);
  });

  afterEach(async () => {
    for (const h of handles) await h.close();
    handles = [];
  });

  it('upsert + get round-trips with a client secret', async () => {
    await store.upsert({
      provider: 'linear',
      clientId: 'cid-x',
      clientSecret: 'shh',
      redirectUri: 'https://x/cb',
    });

    const got = await store.get('linear');
    expect(got).not.toBeNull();
    expect(got!.provider).toBe('linear');
    expect(got!.clientId).toBe('cid-x');
    expect(got!.clientSecret).toBe('shh');
    expect(got!.redirectUri).toBe('https://x/cb');
    expect(typeof got!.updatedAt).toBe('number');

    // The persisted blob must be encrypted — raw SELECT should NOT surface 'shh'.
    const raw = await db
      .selectFrom('admin_oauth_providers')
      .select(['client_secret_enc'])
      .where('provider', '=', 'linear')
      .executeTakeFirst();
    expect((raw as any).client_secret_enc).toBeTruthy();
    expect((raw as any).client_secret_enc).not.toContain('shh');
  });

  it('upsert + get round-trips without a client secret', async () => {
    await store.upsert({
      provider: 'public-thing',
      clientId: 'cid-public',
      redirectUri: 'https://x/cb',
    });

    const got = await store.get('public-thing');
    expect(got).not.toBeNull();
    expect(got!.clientId).toBe('cid-public');
    expect(got!.clientSecret).toBeUndefined();
    expect(got!.redirectUri).toBe('https://x/cb');
  });

  it('upsert twice updates the row; updatedAt is non-decreasing', async () => {
    await store.upsert({
      provider: 'linear',
      clientId: 'cid-first',
      clientSecret: 'first',
      redirectUri: 'https://x/cb',
    });
    const first = await store.get('linear');
    expect(first!.clientId).toBe('cid-first');
    expect(first!.clientSecret).toBe('first');
    const firstAt = first!.updatedAt;

    // Make sure enough real time passes that Math.floor(Date.now()/1000) ticks
    // at least once on fast machines. 1100ms is comfortably over 1s.
    await new Promise(r => setTimeout(r, 1100));

    await store.upsert({
      provider: 'linear',
      clientId: 'cid-second',
      clientSecret: 'second',
      redirectUri: 'https://x/cb2',
    });
    const second = await store.get('linear');
    expect(second!.clientId).toBe('cid-second');
    expect(second!.clientSecret).toBe('second');
    expect(second!.redirectUri).toBe('https://x/cb2');
    expect(second!.updatedAt).toBeGreaterThanOrEqual(firstAt);
  });

  it('list never includes the decrypted secret', async () => {
    await store.upsert({
      provider: 'linear',
      clientId: 'cid-x',
      clientSecret: 'shh',
      redirectUri: 'https://x/cb',
    });

    const rows = await store.list();
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.provider).toBe('linear');
    expect(row.clientId).toBe('cid-x');
    expect(row.redirectUri).toBe('https://x/cb');
    // No clientSecret field at all — and no trace of 'shh' anywhere in the
    // stringified output (structural AND substring guard).
    expect('clientSecret' in (row as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(rows)).not.toContain('shh');
  });

  it('list is sorted ascending by provider name', async () => {
    await store.upsert({ provider: 'zeta', clientId: 'z', redirectUri: 'https://z' });
    await store.upsert({ provider: 'alpha', clientId: 'a', redirectUri: 'https://a' });
    await store.upsert({ provider: 'mike', clientId: 'm', redirectUri: 'https://m' });

    const rows = await store.list();
    expect(rows.map(r => r.provider)).toEqual(['alpha', 'mike', 'zeta']);
  });

  it('delete is idempotent — true on first remove, false on second', async () => {
    await store.upsert({
      provider: 'linear',
      clientId: 'cid-x',
      redirectUri: 'https://x/cb',
    });

    const removed = await store.delete('linear');
    expect(removed).toBe(true);
    expect(await store.get('linear')).toBeNull();

    const removedAgain = await store.delete('linear');
    expect(removedAgain).toBe(false);
  });

  it('get returns null when provider is not registered', async () => {
    expect(await store.get('never-registered')).toBeNull();
  });
});
