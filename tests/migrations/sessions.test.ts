import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { sessionsMigrations } from '../../src/migrations/sessions.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('sessions migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the last_sessions table', async () => {
    db = createTestDb();
    const result = await runMigrations(db, sessionsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    // Insert a row and verify table structure
    const rows = await sql`
      INSERT INTO last_sessions (agent_id, provider, scope, identifiers, updated_at)
      VALUES ('agent-1', 'slack', 'channel:C01', '{"thread":"t1"}', 1700000000)
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.agent_id).toBe('agent-1');
    expect(row.provider).toBe('slack');
    expect(row.scope).toBe('channel:C01');
    expect(row.identifiers).toBe('{"thread":"t1"}');
    expect(row.updated_at).toBe(1700000000);
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, sessionsMigrations);
    const result = await runMigrations(db, sessionsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
