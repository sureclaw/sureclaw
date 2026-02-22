// src/migrations/memory.ts — migration definitions for the memory store
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const memoryMigrations: MigrationSet = {
  memory_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('entries')
        .ifNotExists()
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('scope', 'text', col => col.notNull())
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('tags', 'text')
        .addColumn('taint', 'text')
        .addColumn('created_at', 'text', col =>
          col.notNull().defaultTo(sql`(datetime('now'))`),
        )
        .execute();

      await db.schema
        .createIndex('idx_entries_scope')
        .ifNotExists()
        .on('entries')
        .column('scope')
        .execute();

      // FTS5 virtual tables are not supported by Kysely's schema builder
      await sql`CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(entry_id, content)`.execute(
        db,
      );
    },
    async down(db: Kysely<any>) {
      await sql`DROP TABLE IF EXISTS entries_fts`.execute(db);
      await db.schema.dropTable('entries').execute();
    },
  },

  memory_002_add_agent_id: {
    async up(db: Kysely<any>) {
      // Column may already exist on databases upgraded from pre-migration schema
      try {
        await db.schema
          .alterTable('entries')
          .addColumn('agent_id', 'text')
          .execute();
      } catch {
        // Column already exists — expected for pre-migration databases
      }

      await db.schema
        .createIndex('idx_entries_agent_scope')
        .ifNotExists()
        .on('entries')
        .columns(['agent_id', 'scope'])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema
        .dropIndex('idx_entries_agent_scope')
        .execute();
      // SQLite doesn't support DROP COLUMN before 3.35.0, but we match the
      // forward pattern: the column is nullable so leaving it is acceptable.
      await db.schema
        .alterTable('entries')
        .dropColumn('agent_id')
        .execute();
    },
  },
};
