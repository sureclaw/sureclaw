import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { jobsMigrations } from '../../src/migrations/jobs.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('jobs migrations', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('creates the cron_jobs table and index', async () => {
    db = createTestDb();
    const result = await runMigrations(db, jobsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(3);

    // Insert a row and verify table structure
    const rows = await sql`
      INSERT INTO cron_jobs (id, agent_id, schedule, prompt)
      VALUES ('job1', 'agent-1', '0 9 * * *', 'Check the news')
      RETURNING *
    `.execute(db);

    const row = rows.rows[0] as any;
    expect(row.id).toBe('job1');
    expect(row.agent_id).toBe('agent-1');
    expect(row.schedule).toBe('0 9 * * *');
    expect(row.prompt).toBe('Check the news');
    expect(row.max_token_budget).toBeNull();
    expect(row.delivery).toBeNull();
    expect(row.run_once).toBe(0);
    expect(row.created_at).toBeDefined();
    expect(row.last_fired_at).toBeNull();
  });

  it('is idempotent (ifNotExists)', async () => {
    db = createTestDb();
    await runMigrations(db, jobsMigrations);
    const result = await runMigrations(db, jobsMigrations);
    expect(result.error).toBeUndefined();
    expect(result.applied).toBe(0);
  });
});
