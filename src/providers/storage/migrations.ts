// src/providers/storage/migrations.ts — Dialect-aware storage migrations
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../../utils/migrator.js';

/**
 * Build storage migrations for the given database dialect.
 * Uses the same logical schema but adapts timestamp defaults and
 * autoincrement syntax for SQLite vs PostgreSQL.
 */
export function storageMigrations(dbType: 'sqlite' | 'postgresql'): MigrationSet {
  const isSqlite = dbType === 'sqlite';

  return {
    storage_001_messages: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('messages')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('session_id', 'text', col => col.notNull())
          .addColumn('channel', 'text', col => col.notNull())
          .addColumn('sender', 'text', col => col.notNull())
          .addColumn('content', 'text', col => col.notNull())
          .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
          .addColumn('created_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .addColumn('processed_at', isSqlite ? 'text' : 'timestamptz')
          .execute();

        await db.schema
          .createIndex('idx_messages_status')
          .ifNotExists()
          .on('messages')
          .column('status')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('messages').ifExists().execute();
      },
    },

    storage_002_turns: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await db.schema
            .createTable('turns')
            .ifNotExists()
            .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
            .addColumn('session_id', 'text', col => col.notNull())
            .addColumn('role', 'text', col => col.notNull())
            .addColumn('sender', 'text')
            .addColumn('content', 'text', col => col.notNull())
            .addColumn('created_at', 'integer', col =>
              col.notNull().defaultTo(sql`(unixepoch())`))
            .addColumn('is_summary', 'integer', col => col.notNull().defaultTo(0))
            .addColumn('summarized_up_to', 'integer')
            .execute();
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS turns (
              id SERIAL PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              sender TEXT,
              content TEXT NOT NULL,
              created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
              is_summary INTEGER NOT NULL DEFAULT 0,
              summarized_up_to INTEGER
            )
          `.execute(db);
        }

        await db.schema
          .createIndex('idx_turns_session')
          .ifNotExists()
          .on('turns')
          .columns(['session_id', 'id'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('turns').ifExists().execute();
      },
    },

    storage_003_last_sessions: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('last_sessions')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.primaryKey())
          .addColumn('provider', 'text', col => col.notNull())
          .addColumn('scope', 'text', col => col.notNull())
          .addColumn('identifiers', 'text', col => col.notNull())
          .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col => col.notNull())
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('last_sessions').ifExists().execute();
      },
    },

    storage_004_documents: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await sql`
            CREATE TABLE IF NOT EXISTS documents (
              collection TEXT NOT NULL,
              key        TEXT NOT NULL,
              content    TEXT NOT NULL,
              data       BLOB,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (collection, key)
            )
          `.execute(db);
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS documents (
              collection TEXT NOT NULL,
              key TEXT NOT NULL,
              content TEXT NOT NULL,
              data BYTEA,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (collection, key)
            )
          `.execute(db);
        }
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('documents').ifExists().execute();
      },
    },

    storage_005_chat_sessions: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('chat_sessions')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('title', 'text')
          .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
          .addColumn('created_at', isSqlite ? 'integer' : 'bigint', col =>
            col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
          .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col =>
            col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
          .execute();

        await db.schema
          .createIndex('idx_chat_sessions_updated')
          .ifNotExists()
          .on('chat_sessions')
          .column('updated_at')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('chat_sessions').ifExists().execute();
      },
    },
  };
}
