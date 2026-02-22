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
};
