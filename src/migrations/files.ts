import type { Kysely } from 'kysely';
import type { MigrationSet } from '../utils/migrator.js';
import { type DbDialect, sqlNow } from './dialect.js';

export function buildFilesMigrations(dbType: DbDialect): MigrationSet {
  return {
    files_001_initial: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('files')
          .ifNotExists()
          .addColumn('file_id', 'text', col => col.primaryKey())
          .addColumn('agent_name', 'text', col => col.notNull())
          .addColumn('user_id', 'text', col => col.notNull())
          .addColumn('mime_type', 'text', col => col.notNull())
          .addColumn('created_at', 'text', col =>
            col.notNull().defaultTo(sqlNow(dbType)),
          )
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('files').execute();
      },
    },
  };
}

/** Default SQLite migrations — backward compatible with existing callers. */
export const filesMigrations: MigrationSet = buildFilesMigrations('sqlite');
