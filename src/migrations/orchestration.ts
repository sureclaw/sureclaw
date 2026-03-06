// src/migrations/orchestration.ts — migration definitions for the orchestration event store
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';
import { type DbDialect, sqlEpoch } from './dialect.js';

export function buildOrchestrationMigrations(dbType: DbDialect): MigrationSet {
  return {
    orch_001_events: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('orchestration_events')
          .ifNotExists()
          .addColumn('id', 'text', (col) => col.primaryKey())
          .addColumn('event_type', 'text', (col) => col.notNull())
          .addColumn('handle_id', 'text', (col) => col.notNull())
          .addColumn('agent_id', 'text', (col) => col.notNull())
          .addColumn('session_id', 'text', (col) => col.notNull())
          .addColumn('user_id', 'text', (col) => col.notNull())
          .addColumn('parent_id', 'text')
          .addColumn('payload_json', 'text', (col) => col.notNull())
          .addColumn('created_at', 'integer', (col) =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .execute();

        await db.schema
          .createIndex('idx_orch_events_type')
          .ifNotExists()
          .on('orchestration_events')
          .column('event_type')
          .execute();

        await db.schema
          .createIndex('idx_orch_events_handle')
          .ifNotExists()
          .on('orchestration_events')
          .column('handle_id')
          .execute();

        await db.schema
          .createIndex('idx_orch_events_session')
          .ifNotExists()
          .on('orchestration_events')
          .column('session_id')
          .execute();

        await db.schema
          .createIndex('idx_orch_events_agent')
          .ifNotExists()
          .on('orchestration_events')
          .column('agent_id')
          .execute();

        await db.schema
          .createIndex('idx_orch_events_created')
          .ifNotExists()
          .on('orchestration_events')
          .column('created_at')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('orchestration_events').execute();
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const orchestrationMigrations: MigrationSet = buildOrchestrationMigrations('sqlite');
