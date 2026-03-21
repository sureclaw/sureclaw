// src/providers/credentials/database.ts — Database-backed CredentialProvider
//
// Uses the shared DatabaseProvider (SQLite or PostgreSQL).
// Runs its own migrations against the shared Kysely instance.
// Falls back to process.env for get() — shell-exported and K8s Secret-injected
// vars still work without being stored in the DB.

import { runMigrations } from '../../utils/migrator.js';
import { credentialDbMigrations } from './migrations.js';
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { Kysely } from 'kysely';

const DEFAULT_SCOPE = 'global';

export interface CreateOptions {
  database?: DatabaseProvider;
}

export async function create(
  _config: Config,
  _name?: string,
  opts?: CreateOptions,
): Promise<CredentialProvider> {
  const database = opts?.database;
  if (!database) {
    throw new Error(
      'credentials/database requires a database provider. Set providers.database in ax.yaml.',
    );
  }

  const result = await runMigrations(
    database.db,
    credentialDbMigrations(database.type),
    'credential_migration',
  );
  if (result.error) throw result.error;

  const db: Kysely<any> = database.db;

  return {
    async get(service: string, scope?: string): Promise<string | null> {
      const effectiveScope = scope ?? DEFAULT_SCOPE;
      const row = await db.selectFrom('credential_store')
        .select('value')
        .where('scope', '=', effectiveScope)
        .where('env_name', '=', service)
        .executeTakeFirst();

      if (row) return row.value as string;

      // Only fall back to process.env for default (unscoped) calls
      if (!scope) {
        return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
      }
      return null;
    },

    async set(service: string, value: string, scope?: string): Promise<void> {
      const effectiveScope = scope ?? DEFAULT_SCOPE;
      const now = new Date().toISOString();
      await db.insertInto('credential_store')
        .values({
          scope: effectiveScope,
          env_name: service,
          value,
          created_at: now,
          updated_at: now,
        })
        .onConflict(oc =>
          oc.columns(['scope', 'env_name']).doUpdateSet({
            value,
            updated_at: now,
          })
        )
        .execute();

      // Only update process.env for default (unscoped) calls
      if (!scope) {
        process.env[service] = value;
      }
    },

    async delete(service: string, scope?: string): Promise<void> {
      const effectiveScope = scope ?? DEFAULT_SCOPE;
      await db.deleteFrom('credential_store')
        .where('scope', '=', effectiveScope)
        .where('env_name', '=', service)
        .execute();
      if (!scope) {
        delete process.env[service];
      }
    },

    async list(scope?: string): Promise<string[]> {
      const effectiveScope = scope ?? DEFAULT_SCOPE;
      const rows = await db.selectFrom('credential_store')
        .select('env_name')
        .where('scope', '=', effectiveScope)
        .execute();
      return rows.map(r => r.env_name as string);
    },
  };
}
