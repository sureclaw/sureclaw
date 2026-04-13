// src/migrations/jobs.ts — migration definitions for the jobs store
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';
import { type DbDialect, sqlEpoch } from './dialect.js';

export function buildJobsMigrations(dbType: DbDialect): MigrationSet {
  return {
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
            col.notNull().defaultTo(sqlEpoch(dbType)),
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
    jobs_002_last_fired_at: {
      async up(db: Kysely<any>) {
        await db.schema
          .alterTable('cron_jobs')
          .addColumn('last_fired_at', 'text')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema
          .alterTable('cron_jobs')
          .dropColumn('last_fired_at')
          .execute();
      },
    },
    jobs_003_creator_session_id: {
      async up(db: Kysely<any>) {
        await db.schema
          .alterTable('cron_jobs')
          .addColumn('creator_session_id', 'text')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema
          .alterTable('cron_jobs')
          .dropColumn('creator_session_id')
          .execute();
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const jobsMigrations: MigrationSet = buildJobsMigrations('sqlite');
