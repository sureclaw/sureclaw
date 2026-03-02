// src/migrations/conversations.ts — migration definitions for the conversations store
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const conversationsMigrations: MigrationSet = {
  conversations_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('turns')
        .ifNotExists()
        .addColumn('id', 'integer', col =>
          col.primaryKey().autoIncrement(),
        )
        .addColumn('session_id', 'text', col => col.notNull())
        .addColumn('role', 'text', col => col.notNull())
        .addColumn('sender', 'text')
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('created_at', 'integer', col =>
          col.notNull().defaultTo(sql`(unixepoch())`),
        )
        .execute();

      await db.schema
        .createIndex('idx_turns_session')
        .ifNotExists()
        .on('turns')
        .columns(['session_id', 'id'])
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('turns').execute();
    },
  },

  conversations_002_add_is_summary: {
    async up(db: Kysely<any>) {
      await sql`ALTER TABLE turns ADD COLUMN is_summary INTEGER NOT NULL DEFAULT 0`.execute(db);
      await sql`ALTER TABLE turns ADD COLUMN summarized_up_to INTEGER`.execute(db);
    },
    async down(db: Kysely<any>) {
      // SQLite doesn't support DROP COLUMN before 3.35.0; recreate table
      await sql`CREATE TABLE turns_backup AS SELECT id, session_id, role, sender, content, created_at FROM turns`.execute(db);
      await sql`DROP TABLE turns`.execute(db);
      await sql`ALTER TABLE turns_backup RENAME TO turns`.execute(db);
    },
  },
};
