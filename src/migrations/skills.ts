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
        // ifExists so a partial-apply doesn't wedge the migration on rollback.
        await db.schema.dropTable('skill_setup_queue').ifExists().execute();
        await db.schema.dropTable('skill_states').ifExists().execute();
      },
    },

    skills_002_tuple_tables: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('skill_credentials')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('skill_name', 'text', col => col.notNull())
          .addColumn('env_name', 'text', col => col.notNull())
          // Empty string is the agent-scope sentinel ("shared across users").
          // Postgres disallows NULLs in a PK constraint, so we use '' instead
          // of NULL. Turn-time lookup becomes:
          //   WHERE user_id = $session_user_id OR user_id = ''
          .addColumn('user_id', 'text', col => col.notNull().defaultTo(''))
          .addColumn('value', 'text', col => col.notNull())
          .addColumn('created_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .addColumn('updated_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .addPrimaryKeyConstraint('pk_skill_credentials', [
            'agent_id',
            'skill_name',
            'env_name',
            'user_id',
          ])
          .execute();

        await db.schema
          .createTable('skill_domain_approvals')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('skill_name', 'text', col => col.notNull())
          .addColumn('domain', 'text', col => col.notNull())
          .addColumn('approved_at', 'integer', col =>
            col.notNull().defaultTo(sqlEpoch(dbType)),
          )
          .addPrimaryKeyConstraint('pk_skill_domain_approvals', [
            'agent_id',
            'skill_name',
            'domain',
          ])
          .execute();

        await db.schema
          .createIndex('idx_skill_credentials_agent_skill')
          .ifNotExists()
          .on('skill_credentials')
          .columns(['agent_id', 'skill_name'])
          .execute();

        await db.schema
          .createIndex('idx_skill_domain_approvals_agent_skill')
          .ifNotExists()
          .on('skill_domain_approvals')
          .columns(['agent_id', 'skill_name'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema
          .dropIndex('idx_skill_domain_approvals_agent_skill')
          .ifExists()
          .execute();
        await db.schema
          .dropIndex('idx_skill_credentials_agent_skill')
          .ifExists()
          .execute();
        await db.schema.dropTable('skill_domain_approvals').ifExists().execute();
        await db.schema.dropTable('skill_credentials').ifExists().execute();
      },
    },

    skills_003_drop_retired_tables: {
      async up(db: Kysely<any>) {
        await db.schema.dropTable('skill_setup_queue').ifExists().execute();
        await db.schema.dropTable('skill_states').ifExists().execute();
      },
      async down(_db: Kysely<any>) {
        // One-way migration. Rolling back requires reverting the code that
        // removed the readers; re-creating empty shells would be misleading.
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const skillsMigrations: MigrationSet = buildSkillsMigrations('sqlite');
