import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { conversationsMigrations } from '../../src/migrations/conversations.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('conversations migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the turns table and index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, conversationsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    // Insert a row and verify table structure
    const rows = await sql`
      INSERT INTO turns (session_id, role, sender, content)
      VALUES ('sess1', 'user', 'alice', 'What is the weather?')
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.id).toBe(1);
    expect(row.session_id).toBe('sess1');
    expect(row.role).toBe('user');
    expect(row.sender).toBe('alice');
    expect(row.content).toBe('What is the weather?');
    expect(row.created_at).toBeDefined();
  });

  it('auto-increments turn IDs', async () => {
    db = createTestDb();
    await runMigrations(db, conversationsMigrations);

    await sql`INSERT INTO turns (session_id, role, content) VALUES ('s1', 'user', 'first')`.execute(db);
    await sql`INSERT INTO turns (session_id, role, content) VALUES ('s1', 'assistant', 'second')`.execute(db);

    const rows = await sql`SELECT id FROM turns ORDER BY id`.execute(db);
    expect((rows.rows[0] as any).id).toBe(1);
    expect((rows.rows[1] as any).id).toBe(2);
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, conversationsMigrations);
    const result = await runMigrations(db, conversationsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
