import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations, type MigrationSet } from '../../src/utils/migrator.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('runMigrations', () => {
  let db: Kysely<any>;

  afterEach(async () => {
    await db?.destroy();
  });

  it('runs migrations in order and creates the tracking table', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_create_items': {
        async up(db) {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', col => col.primaryKey())
            .addColumn('name', 'text', col => col.notNull())
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('items').execute();
        },
      },
      'test_002_add_status': {
        async up(db) {
          await db.schema
            .alterTable('items')
            .addColumn('status', 'text', col => col.defaultTo('active'))
            .execute();
        },
        async down(db) {
          await db.schema.alterTable('items').dropColumn('status').execute();
        },
      },
    };

    const result = await runMigrations(db, migrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(2);

    // Verify the table exists with both columns
    const rows = await sql`INSERT INTO items (id, name) VALUES ('1', 'test') RETURNING *`.execute(db);
    expect((rows.rows[0] as any).status).toBe('active');
  });

  it('skips already-applied migrations', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_create_items': {
        async up(db) {
          await db.schema
            .createTable('items')
            .addColumn('id', 'text', col => col.primaryKey())
            .execute();
        },
        async down(db) {
          await db.schema.dropTable('items').execute();
        },
      },
    };

    await runMigrations(db, migrations);
    const result = await runMigrations(db, migrations);
    expect(result.applied).toBe(0);
  });

  it('returns error details on migration failure', async () => {
    db = createTestDb();
    const migrations: MigrationSet = {
      'test_001_bad': {
        async up(db) {
          await sql`ALTER TABLE nonexistent ADD COLUMN x TEXT`.execute(db);
        },
        async down() {},
      },
    };

    const result = await runMigrations(db, migrations);
    expect(result.error).toBeDefined();
  });
});
