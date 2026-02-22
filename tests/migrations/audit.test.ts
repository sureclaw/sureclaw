import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { auditMigrations } from '../../src/migrations/audit.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('audit migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the audit_log table and indexes', async () => {
    db = createTestDb();
    const result = await runMigrations(db, auditMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(1);

    // Insert a row and verify table structure
    const rows = await sql`
      INSERT INTO audit_log (session_id, action, args, result, taint, duration_ms, token_input, token_output)
      VALUES ('sess1', 'llm_call', '{"model":"claude"}', 'ok', 'external', 123.45, 100, 50)
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.id).toBe(1);
    expect(row.timestamp).toBeDefined();
    expect(row.session_id).toBe('sess1');
    expect(row.action).toBe('llm_call');
    expect(row.args).toBe('{"model":"claude"}');
    expect(row.result).toBe('ok');
    expect(row.taint).toBe('external');
    expect(row.duration_ms).toBeCloseTo(123.45);
    expect(row.token_input).toBe(100);
    expect(row.token_output).toBe(50);
  });

  it('auto-increments audit log IDs', async () => {
    db = createTestDb();
    await runMigrations(db, auditMigrations);

    await sql`INSERT INTO audit_log (action, result) VALUES ('a1', 'ok')`.execute(db);
    await sql`INSERT INTO audit_log (action, result) VALUES ('a2', 'ok')`.execute(db);

    const rows = await sql`SELECT id FROM audit_log ORDER BY id`.execute(db);
    expect((rows.rows[0] as any).id).toBe(1);
    expect((rows.rows[1] as any).id).toBe(2);
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, auditMigrations);
    const result = await runMigrations(db, auditMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
