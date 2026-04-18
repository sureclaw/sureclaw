// tests/migrations/storage-drop-legacy-documents.test.ts
//
// Smoke test for storage_008_drop_legacy_documents (phase 7 cleanup).
// Verifies the migration:
//   - deletes rows where collection IN ('plugins', 'skills')
//   - leaves rows with other collections untouched
//   - is idempotent
//   - is safe to run before the documents table exists
import { describe, it, expect, afterEach } from 'vitest';
import { Kysely, SqliteDialect, sql } from 'kysely';
import Database from 'better-sqlite3';
import { runMigrations } from '../../src/utils/migrator.js';
import { storageMigrations } from '../../src/providers/storage/migrations.js';

function createTestDb(): Kysely<any> {
  return new Kysely({ dialect: new SqliteDialect({ database: new Database(':memory:') }) });
}

describe('storage_008_drop_legacy_documents', () => {
  let db: Kysely<any>;
  afterEach(async () => { await db?.destroy(); });

  it('deletes plugins + skills rows and preserves other collections', async () => {
    db = createTestDb();

    // Run migrations up through 007 only — hand-roll the documents table
    // insertion, then run the full migration set (which includes 008).
    // Easiest path: run the full set (which creates the table AND deletes
    // in one pass), but to observe the delete we need pre-seeded rows.
    // So: apply migrations first with only storage_004 behavior by running
    // the full set once (data starts empty), seed, then re-run — the
    // migrator will skip already-applied migrations so our 008 won't
    // re-delete. We need a different approach: apply all migrations first,
    // insert retired rows AFTER, then prove that re-running the set
    // (with migration-history populated) is a no-op for our cleanup. That
    // isn't what we want either.
    //
    // Approach used here: build a custom migration set containing only
    // storage_004 (create documents table), seed rows, then run the full
    // set against a separate migration-tracking table so 008 fires once
    // against our seeded data.
    const all = storageMigrations('sqlite');

    // First, create just the documents table by running migrations up to
    // and including storage_004. We do this by running the full set under
    // a distinct tracking table, but we need 008 to NOT run yet — so we
    // pre-insert rows into the tracking table to mark 008 as pending (the
    // default) and 005/006/007 as applied. Easier: run only the first 4
    // migrations by passing a trimmed set.
    const tablesOnly = Object.fromEntries(
      Object.entries(all).filter(([k]) =>
        ['storage_001_messages', 'storage_002_turns', 'storage_003_last_sessions', 'storage_004_documents']
          .includes(k),
      ),
    );
    const firstPass = await runMigrations(db, tablesOnly, 'storage_migration');
    expect(firstPass.error).toBeUndefined();
    expect(firstPass.applied).toBe(4);

    // Seed mixed collections.
    await sql`
      INSERT INTO documents (collection, key, content) VALUES
        ('plugins', 'old-plugin-a', '{"manifest":"stuff"}'),
        ('plugins', 'old-plugin-b', '{"manifest":"more"}'),
        ('skills',  'agent-1/legacy-skill', '# legacy'),
        ('skills',  'agent-1/users/alice/custom', '# custom'),
        ('identity','IDENTITY.md', '# ident'),
        ('config',  'ax.yaml', 'x: 1')
    `.execute(db);

    // Now run the full migration set against the same tracking table — this
    // applies storage_005..008 in order. 008's up() should run and delete
    // the plugins/skills rows.
    const secondPass = await runMigrations(db, all, 'storage_migration');
    expect(secondPass.error).toBeUndefined();
    expect(secondPass.applied).toBe(4); // 005, 006, 007, 008

    // Plugins + skills rows gone.
    const remaining = await sql<{ collection: string; key: string }>`
      SELECT collection, key FROM documents ORDER BY collection, key
    `.execute(db);
    expect(remaining.rows).toEqual([
      { collection: 'config', key: 'ax.yaml' },
      { collection: 'identity', key: 'IDENTITY.md' },
    ]);
  });

  it('is idempotent (re-running is a no-op)', async () => {
    db = createTestDb();
    const all = storageMigrations('sqlite');
    await runMigrations(db, all, 'storage_migration');
    const second = await runMigrations(db, all, 'storage_migration');
    expect(second.error).toBeUndefined();
    expect(second.applied).toBe(0);
  });

  it('survives when the documents table does not exist', async () => {
    // Edge case: if somehow a DB skipped storage_004 (shouldn't happen in
    // practice, but the plan calls for graceful handling), running 008 in
    // isolation must not blow up.
    db = createTestDb();
    const { storage_008_drop_legacy_documents } = storageMigrations('sqlite') as any;
    // Calling the up() directly without the preceding migrations — the
    // documents table is absent. Should swallow the "no such table" error.
    await expect(storage_008_drop_legacy_documents.up(db)).resolves.toBeUndefined();
  });
});
