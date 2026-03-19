// src/providers/credentials/migrations.ts — Dialect-aware credential store migrations
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../../utils/migrator.js';

export function credentialDbMigrations(dbType: 'sqlite' | 'postgresql'): MigrationSet {
  const isSqlite = dbType === 'sqlite';

  return {
    cred_001_initial: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await db.schema
            .createTable('credential_store')
            .ifNotExists()
            .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
            .addColumn('scope', 'text', col => col.notNull().defaultTo('global'))
            .addColumn('env_name', 'text', col => col.notNull())
            .addColumn('value', 'text', col => col.notNull())
            .addColumn('created_at', 'text', col =>
              col.notNull().defaultTo(sql`(datetime('now'))`))
            .addColumn('updated_at', 'text', col =>
              col.notNull().defaultTo(sql`(datetime('now'))`))
            .execute();
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS credential_store (
              id SERIAL PRIMARY KEY,
              scope TEXT NOT NULL DEFAULT 'global',
              env_name TEXT NOT NULL,
              value TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
          `.execute(db);
        }

        await db.schema
          .createIndex('idx_credential_scope_env')
          .ifNotExists()
          .on('credential_store')
          .columns(['scope', 'env_name'])
          .unique()
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('credential_store').ifExists().execute();
      },
    },
  };
}
