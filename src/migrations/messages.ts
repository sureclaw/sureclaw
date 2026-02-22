// src/migrations/messages.ts — migration definitions for the messages store
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const messagesMigrations: MigrationSet = {
  messages_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('messages')
        .ifNotExists()
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('session_id', 'text', col => col.notNull())
        .addColumn('channel', 'text', col => col.notNull())
        .addColumn('sender', 'text', col => col.notNull())
        .addColumn('content', 'text', col => col.notNull())
        .addColumn('status', 'text', col =>
          col.notNull().defaultTo("pending"),
        )
        .addColumn('created_at', 'text', col =>
          col.notNull().defaultTo(sql`(datetime('now'))`),
        )
        .addColumn('processed_at', 'text')
        .execute();

      await db.schema
        .createIndex('idx_messages_status')
        .ifNotExists()
        .on('messages')
        .column('status')
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('messages').execute();
    },
  },
};
