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
  const scope = DEFAULT_SCOPE;

  return {
    async get(service: string): Promise<string | null> {
      const row = await db.selectFrom('credential_store')
        .select('value')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .executeTakeFirst();

      if (row) return row.value as string;

      // Fall back to process.env (case-insensitive: try exact, then UPPER)
      return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
    },

    async set(service: string, value: string): Promise<void> {
      const existing = await db.selectFrom('credential_store')
        .select('id')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .executeTakeFirst();

      if (existing) {
        await db.updateTable('credential_store')
          .set({
            value,
            updated_at: new Date().toISOString(),
          })
          .where('scope', '=', scope)
          .where('env_name', '=', service)
          .execute();
      } else {
        await db.insertInto('credential_store')
          .values({
            scope,
            env_name: service,
            value,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute();
      }

      // Also update process.env so the value is immediately available
      process.env[service] = value;
    },

    async delete(service: string): Promise<void> {
      await db.deleteFrom('credential_store')
        .where('scope', '=', scope)
        .where('env_name', '=', service)
        .execute();
      delete process.env[service];
    },

    async list(): Promise<string[]> {
      const rows = await db.selectFrom('credential_store')
        .select('env_name')
        .where('scope', '=', scope)
        .execute();
      return rows.map(r => r.env_name as string);
    },
  };
}
