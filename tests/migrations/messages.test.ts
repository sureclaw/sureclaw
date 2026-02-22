import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { messagesMigrations } from '../../src/migrations/messages.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('messages migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the messages table and index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, messagesMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    // Insert a row and verify table structure
    const rows = await sql`
      INSERT INTO messages (id, session_id, channel, sender, content)
      VALUES ('m1', 'sess1', 'slack', 'alice', 'hello world')
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.id).toBe('m1');
    expect(row.session_id).toBe('sess1');
    expect(row.channel).toBe('slack');
    expect(row.sender).toBe('alice');
    expect(row.content).toBe('hello world');
    expect(row.status).toBe('pending');
    expect(row.created_at).toBeDefined();
    expect(row.processed_at).toBeNull();
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, messagesMigrations);
    const result = await runMigrations(db, messagesMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
