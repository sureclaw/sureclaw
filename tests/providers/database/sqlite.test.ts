import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/database/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Config } from '../../../src/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';

const config = {} as Config;

describe('database/sqlite', () => {
  let provider: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-db-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    provider = await create(config);
  });

  afterEach(async () => {
    try { await provider.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  test('creates successfully with correct type', () => {
    expect(provider.type).toBe('sqlite');
  });

  test('db is a Kysely instance that can execute queries', async () => {
    const result = await sql`SELECT 1 as val`.execute(provider.db);
    expect(result.rows[0]).toEqual({ val: 1 });
  });

  test('vectorsAvailable reflects sqlite-vec status', () => {
    // sqlite-vec may or may not be available; just check it's boolean
    expect(typeof provider.vectorsAvailable).toBe('boolean');
  });

  test('consumers can run their own migrations', async () => {
    // Simulate a consumer creating its own table
    await provider.db.schema
      .createTable('test_table')
      .addColumn('id', 'integer', col => col.primaryKey())
      .addColumn('name', 'text', col => col.notNull())
      .execute();

    await provider.db
      .insertInto('test_table')
      .values({ id: 1, name: 'hello' })
      .execute();

    const rows = await provider.db
      .selectFrom('test_table')
      .selectAll()
      .execute();

    expect(rows).toEqual([{ id: 1, name: 'hello' }]);
  });

  test('close() works without error', async () => {
    await expect(provider.close()).resolves.toBeUndefined();
  });

  test('WAL mode is enabled', async () => {
    const result = await sql`PRAGMA journal_mode`.execute(provider.db);
    expect((result.rows[0] as any).journal_mode).toBe('wal');
  });

  test('foreign keys are enabled', async () => {
    const result = await sql`PRAGMA foreign_keys`.execute(provider.db);
    expect((result.rows[0] as any).foreign_keys).toBe(1);
  });
});
