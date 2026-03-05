// src/migrations/jobs.ts — migration definitions for the jobs store
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';

export const jobsMigrations: MigrationSet = {
  jobs_001_initial: {
    async up(db: Kysely<any>) {
      await db.schema
        .createTable('cron_jobs')
        .ifNotExists()
        .addColumn('id', 'text', col => col.primaryKey())
        .addColumn('agent_id', 'text', col => col.notNull())
        .addColumn('schedule', 'text', col => col.notNull())
        .addColumn('prompt', 'text', col => col.notNull())
        .addColumn('max_token_budget', 'integer')
        .addColumn('delivery', 'text')
        .addColumn('run_once', 'integer', col =>
          col.notNull().defaultTo(0),
        )
        .addColumn('run_at', 'text')
        .addColumn('created_at', 'integer', col =>
          col.notNull().defaultTo(sql`(unixepoch())`),
        )
        .execute();

      await db.schema
        .createIndex('idx_cron_jobs_agent')
        .ifNotExists()
        .on('cron_jobs')
        .column('agent_id')
        .execute();
    },
    async down(db: Kysely<any>) {
      await db.schema.dropTable('cron_jobs').execute();
    },
  },
};
