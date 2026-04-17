// src/host/admin-oauth-providers.ts — Admin-registered OAuth provider storage
// plus the crypto helpers used to encrypt client secrets at rest.
//
// Phase 6 Task 1 foundation: the `admin_oauth_providers` table holds
// pre-configured client_id + (optional) client_secret + redirect_uri per
// provider name ('linear', 'slack', ...). Admin-registered providers
// override any `client_id` declared in a skill's frontmatter, which is
// how we upgrade a public-client skill to a confidential-client one
// without rewriting the skill.
//
// Secrets are encrypted with AES-256-GCM before write and decrypted on
// read. The encryption key is derived in one of two ways (see
// `deriveOAuthKey`):
//   1. `AX_OAUTH_SECRET_KEY` env var — 32 hex-encoded bytes (preferred).
//   2. sha256(admin.token) — fallback when the env var is unset.
//
// List operations NEVER include the decrypted secret: listings go over
// the wire to the admin dashboard, and we don't want a stray JSON.stringify
// to ship a bearer secret to a browser. Callers that need the secret
// (the OAuth start/callback flow) must use `get(provider)` explicitly.

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import type { Kysely } from 'kysely';

// ── Crypto helpers ──

/** Derive a 32-byte encryption key.
 *
 *  Priority: `AX_OAUTH_SECRET_KEY` env var (hex-encoded 32 bytes) >
 *  sha256(adminToken). Callers should log a warning when the env var is
 *  unset so ops know they're running on the fallback key — rotating the
 *  admin token would then also rotate the encryption key, which breaks
 *  decryption of any already-stored secrets.
 */
export function deriveOAuthKey(
  adminToken: string,
  envKey?: string,
): { key: Buffer; derivedFrom: 'env' | 'admin-token' } {
  if (envKey) {
    const buf = Buffer.from(envKey, 'hex');
    if (buf.length !== 32) {
      throw new Error('AX_OAUTH_SECRET_KEY must be 32 hex-encoded bytes');
    }
    return { key: buf, derivedFrom: 'env' };
  }
  const key = createHash('sha256').update(adminToken).digest();
  return { key, derivedFrom: 'admin-token' };
}

/** AES-256-GCM encrypt. Returns base64(iv || ciphertext || tag). */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, enc, tag]).toString('base64');
}

/** AES-256-GCM decrypt. Throws on tamper (GCM integrity check). */
export function decryptSecret(blob: string, key: Buffer): string {
  const buf = Buffer.from(blob, 'base64');
  // iv (12 bytes) + tag (16 bytes) is the minimum — anything shorter is
  // structurally invalid before we even touch the cipher.
  if (buf.length < 12 + 16) throw new Error('oauth_secret_blob_too_short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// ── Storage module ──

export interface AdminOAuthProvider {
  provider: string;
  clientId: string;
  /** Decrypted at read; absent when the stored row has NULL (public-client config). */
  clientSecret?: string;
  redirectUri: string;
  /** Unix epoch seconds (matches sqlEpoch). */
  updatedAt: number;
}

export interface AdminOAuthProviderStore {
  get(provider: string): Promise<AdminOAuthProvider | null>;
  /** List NEVER includes `clientSecret` — listings go over the wire unencrypted. */
  list(): Promise<Array<Omit<AdminOAuthProvider, 'clientSecret'>>>;
  upsert(input: {
    provider: string;
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
  }): Promise<void>;
  /** Returns true when a row was removed. */
  delete(provider: string): Promise<boolean>;
}

type AdminOAuthRow = {
  provider: string;
  client_id: string;
  client_secret_enc: string | null;
  redirect_uri: string;
  updated_at: number;
};

export function createAdminOAuthProviderStore(
  db: Kysely<any>,
  key: Buffer,
): AdminOAuthProviderStore {
  return {
    async get(provider) {
      const row = (await db
        .selectFrom('admin_oauth_providers')
        .select(['provider', 'client_id', 'client_secret_enc', 'redirect_uri', 'updated_at'])
        .where('provider', '=', provider)
        .executeTakeFirst()) as AdminOAuthRow | undefined;
      if (!row) return null;
      const out: AdminOAuthProvider = {
        provider: row.provider,
        clientId: row.client_id,
        redirectUri: row.redirect_uri,
        updatedAt: Number(row.updated_at),
      };
      if (row.client_secret_enc) {
        out.clientSecret = decryptSecret(row.client_secret_enc, key);
      }
      return out;
    },

    async list() {
      const rows = (await db
        .selectFrom('admin_oauth_providers')
        .select(['provider', 'client_id', 'redirect_uri', 'updated_at'])
        .orderBy('provider', 'asc')
        .execute()) as Array<Omit<AdminOAuthRow, 'client_secret_enc'>>;
      return rows.map(r => ({
        provider: r.provider,
        clientId: r.client_id,
        redirectUri: r.redirect_uri,
        updatedAt: Number(r.updated_at),
      }));
    },

    async upsert(input) {
      const enc = input.clientSecret ? encryptSecret(input.clientSecret, key) : null;
      // SQLite + Postgres both support `INSERT ... ON CONFLICT ... DO UPDATE`
      // via Kysely. Explicit `updated_at` bump on conflict matches the
      // `sqlEpoch` default applied on first insert.
      await db
        .insertInto('admin_oauth_providers')
        .values({
          provider: input.provider,
          client_id: input.clientId,
          client_secret_enc: enc,
          redirect_uri: input.redirectUri,
        })
        .onConflict(oc =>
          oc.column('provider').doUpdateSet({
            client_id: input.clientId,
            client_secret_enc: enc,
            redirect_uri: input.redirectUri,
            updated_at: Math.floor(Date.now() / 1000),
          }),
        )
        .execute();
    },

    async delete(provider) {
      const res = await db
        .deleteFrom('admin_oauth_providers')
        .where('provider', '=', provider)
        .execute();
      // Kysely returns DeleteResult[] (one per executed statement); sum
      // numDeletedRows across the batch so callers can distinguish "a row
      // was removed" from "nothing matched" for idempotent API contracts.
      const total = res.reduce(
        (n: bigint, r: { numDeletedRows: bigint }) => n + r.numDeletedRows,
        0n,
      );
      return total > 0n;
    },
  };
}
