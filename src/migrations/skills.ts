// src/migrations/skills.ts — migration definitions for the skills state + setup queue
import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';
import { type DbDialect, sqlEpoch } from './dialect.js';

export function buildSkillsMigrations(dbType: DbDialect): MigrationSet {
  return {
    skills_001_initial: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('skill_states')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('skill_name', 'text', col => col.notNull())
          .addColumn('kind', 'text', col => col.notNull())
          .addColumn('description', 'text')
          .addColumn('pending_reasons', 'text') // JSON array or NULL
          .addColumn('error', 'text')
          .addColumn('updated_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .addPrimaryKeyConstraint('pk_skill_states', ['agent_id', 'skill_name'])
          .execute();

        await db.schema
          .createTable('skill_setup_queue')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('skill_name', 'text', col => col.notNull())
          .addColumn('payload', 'text', col => col.notNull()) // full SetupRequest JSON
          .addColumn('created_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .addPrimaryKeyConstraint('pk_skill_setup_queue', ['agent_id', 'skill_name'])
          .execute();

        await db.schema
          .createIndex('idx_skill_states_agent')
          .ifNotExists()
          .on('skill_states')
          .column('agent_id')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('skill_setup_queue').execute();
        await db.schema.dropTable('skill_states').execute();
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const skillsMigrations: MigrationSet = buildSkillsMigrations('sqlite');
