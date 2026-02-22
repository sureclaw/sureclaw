import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { memoryMigrations } from '../../src/migrations/memory.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('memory migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates entries table, FTS5 table, and index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, memoryMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(2);

    // Insert into entries table
    const rows = await sql`
      INSERT INTO entries (id, scope, content, tags, taint)
      VALUES ('e1', 'global', 'remember this fact', 'important,fact', 'user')
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.id).toBe('e1');
    expect(row.scope).toBe('global');
    expect(row.content).toBe('remember this fact');
    expect(row.tags).toBe('important,fact');
    expect(row.taint).toBe('user');
    expect(row.created_at).toBeDefined();
    // agent_id column added by second migration
    expect(row.agent_id).toBeNull();
  });

  it('creates FTS5 virtual table for full-text search', async () => {
    db = createTestDb();
    await runMigrations(db, memoryMigrations);

    // Insert into FTS5 table and search
    await sql`INSERT INTO entries_fts (entry_id, content) VALUES ('e1', 'the quick brown fox')`.execute(db);
    await sql`INSERT INTO entries_fts (entry_id, content) VALUES ('e2', 'lazy dog sleeps')`.execute(db);

    const results = await sql`SELECT entry_id FROM entries_fts WHERE entries_fts MATCH 'fox'`.execute(db);
    expect(results.rows).toHaveLength(1);
    expect((results.rows[0] as any).entry_id).toBe('e1');
  });

  it('adds agent_id column in second migration', async () => {
    db = createTestDb();
    await runMigrations(db, memoryMigrations);

    // Insert with agent_id
    await sql`
      INSERT INTO entries (id, scope, content, agent_id)
      VALUES ('e2', 'agent-scope', 'agent memory', 'agent-1')
    `.execute(db);

    const rows = await sql`SELECT agent_id FROM entries WHERE id = 'e2'`.execute(db);
    expect((rows.rows[0] as any).agent_id).toBe('agent-1');
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, memoryMigrations);
    const result = await runMigrations(db, memoryMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
