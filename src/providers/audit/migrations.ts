// src/providers/audit/migrations.ts — Dialect-aware audit migrations
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../../utils/migrator.js';

export function auditDbMigrations(dbType: 'sqlite' | 'postgresql'): MigrationSet {
  const isSqlite = dbType === 'sqlite';

  return {
    audit_001_initial: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await db.schema
            .createTable('audit_log')
            .ifNotExists()
            .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
            .addColumn('timestamp', 'text', col =>
              col.notNull().defaultTo(sql`(datetime('now'))`))
            .addColumn('session_id', 'text')
            .addColumn('action', 'text', col => col.notNull())
            .addColumn('args', 'text')
            .addColumn('result', 'text', col => col.notNull())
            .addColumn('taint', 'text')
            .addColumn('duration_ms', 'real')
            .addColumn('token_input', 'integer')
            .addColumn('token_output', 'integer')
            .execute();
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS audit_log (
              id SERIAL PRIMARY KEY,
              timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              session_id TEXT,
              action TEXT NOT NULL,
              args TEXT,
              result TEXT NOT NULL,
              taint TEXT,
              duration_ms REAL,
              token_input INTEGER,
              token_output INTEGER
            )
          `.execute(db);
        }

        await db.schema
          .createIndex('idx_audit_session')
          .ifNotExists()
          .on('audit_log')
          .columns(['session_id', 'timestamp'])
          .execute();

        await db.schema
          .createIndex('idx_audit_action')
          .ifNotExists()
          .on('audit_log')
          .columns(['action', 'timestamp'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('audit_log').ifExists().execute();
      },
    },
  };
}
