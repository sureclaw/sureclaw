// src/migrations/sessions.ts — migration definitions for the sessions store
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const sessionsMigrations: MigrationSet = {
  sessions_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('last_sessions')
        .ifNotExists()
        .addColumn('agent_id', 'text', col => col.primaryKey())
        .addColumn('provider', 'text', col => col.notNull())
        .addColumn('scope', 'text', col => col.notNull())
        .addColumn('identifiers', 'text', col => col.notNull())
        .addColumn('updated_at', 'integer', col => col.notNull())
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('last_sessions').execute();
    },
  },
};
