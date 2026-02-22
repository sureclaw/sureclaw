import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { runMigrations } from '../../src/utils/migrator.js';
import { messagesMigrations } from '../../src/migrations/messages.js';
import { memoryMigrations } from '../../src/migrations/memory.js';
import { sessionsMigrations } from '../../src/migrations/sessions.js';
import { conversationsMigrations } from '../../src/migrations/conversations.js';
import { jobsMigrations } from '../../src/migrations/jobs.js';
import { auditMigrations } from '../../src/migrations/audit.js';

describe('upgrade path: existing databases', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-upgrade-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('messages: migrates a database created by old inline SQL', async () => {
    const dbPath = join(tmpDir, 'messages.db');

    // Simulate old database created by inline SQL (no kysely_migration table)
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      )
    `);
    raw.exec(`CREATE INDEX idx_messages_status ON messages(status)`);
    raw.exec(`INSERT INTO messages (id, session_id, channel, sender, content, status) VALUES ('old1', 's1', 'cli', 'user', 'existing data', 'pending')`);
    raw.close();

    // Run Kysely migrations against this existing database
    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(dbPath) }) });
    const result = await runMigrations(db, messagesMigrations);
    expect(result.error).toBeUndefined();
    // The 001_initial should be a no-op because of ifNotExists(), but still recorded
    expect(result.applied).toBe(1);

    // Verify existing data survived
    const { rows } = await sql`SELECT * FROM messages WHERE id = 'old1'`.execute(db);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).content).toBe('existing data');

    await db.destroy();
  });

  it('memory: migrates a database that already has agent_id column', async () => {
    const dbPath = join(tmpDir, 'memory.db');

    // Simulate old database with agent_id already added via try-catch ALTER TABLE
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT,
        taint TEXT,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    raw.exec(`CREATE INDEX idx_entries_scope ON entries(scope)`);
    raw.exec(`CREATE INDEX idx_entries_agent_scope ON entries(agent_id, scope)`);
    raw.exec(`CREATE VIRTUAL TABLE entries_fts USING fts5(entry_id, content)`);
    raw.exec(`INSERT INTO entries (id, scope, content, agent_id) VALUES ('e1', 'global', 'old memory', 'agent-1')`);
    raw.close();

    const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(dbPath) }) });
    const result = await runMigrations(db, memoryMigrations);
    expect(result.error).toBeUndefined();
    // Both migrations should be recorded (001 is ifNotExists no-op, 002 tries to add column but catches the error)
    expect(result.applied).toBe(2);

    // Verify existing data survived
    const { rows } = await sql`SELECT * FROM entries WHERE id = 'e1'`.execute(db);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).agent_id).toBe('agent-1');

    await db.destroy();
  });

  it('all stores: double migration is idempotent', async () => {
    const allMigrations = [
      { name: 'messages', migrations: messagesMigrations },
      { name: 'sessions', migrations: sessionsMigrations },
      { name: 'conversations', migrations: conversationsMigrations },
      { name: 'jobs', migrations: jobsMigrations },
      { name: 'memory', migrations: memoryMigrations },
      { name: 'audit', migrations: auditMigrations },
    ];

    for (const { name, migrations } of allMigrations) {
      const dbPath = join(tmpDir, `${name}.db`);
      const db = new Kysely({ dialect: new SqliteDialect({ database: new Database(dbPath) }) });

      const first = await runMigrations(db, migrations);
      expect(first.error).toBeUndefined();
      expect(first.applied).toBeGreaterThan(0);

      const second = await runMigrations(db, migrations);
      expect(second.error).toBeUndefined();
      expect(second.applied).toBe(0);

      await db.destroy();
    }
  });
});
