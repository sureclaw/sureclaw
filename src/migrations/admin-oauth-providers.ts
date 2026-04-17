// src/migrations/admin-oauth-providers.ts — migration definitions for the
// admin-registered OAuth providers table (phase 6 task 1).
//
// One row per provider (e.g. 'linear', 'slack'). client_secret_enc holds an
// AES-256-GCM blob when the provider is configured as a confidential client;
// for public-client configs it's NULL.
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';
import { type DbDialect, sqlEpoch } from './dialect.js';

export function buildAdminOAuthMigrations(dbType: DbDialect): MigrationSet {
  return {
    admin_oauth_001_initial: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('admin_oauth_providers')
          .ifNotExists()
          .addColumn('provider', 'text', col => col.primaryKey())
          .addColumn('client_id', 'text', col => col.notNull())
          // base64(iv || ciphertext || tag); NULL for public-client configs
          .addColumn('client_secret_enc', 'text')
          .addColumn('redirect_uri', 'text', col => col.notNull())
          .addColumn('updated_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .execute();
      },
      async down(db: Kysely<any>) {
        // ifExists so a partial-apply doesn't wedge the migration on rollback.
        await db.schema.dropTable('admin_oauth_providers').ifExists().execute();
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const adminOAuthMigrations: MigrationSet = buildAdminOAuthMigrations('sqlite');
