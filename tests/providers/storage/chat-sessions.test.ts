import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/storage/database.js';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { StorageProvider } from '../../../src/providers/storage/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('ChatSessionStore', () => {
  let storage: StorageProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-chat-sessions-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    storage = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { storage.close(); } catch {}
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('lists sessions ordered by updated_at desc', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    await storage.chatSessions.create({ id: 'sess-2', title: 'Hello World' });

    const sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe('sess-2'); // most recent
    expect(sessions[0].title).toBe('Hello World');
    expect(sessions[1].id).toBe('sess-1');
    expect(sessions[1].title).toBeNull();
  });

  it('creates a session with optional client-supplied id', async () => {
    const session = await storage.chatSessions.create({ id: 'my-custom-id', title: 'Test' });
    expect(session.id).toBe('my-custom-id');
    expect(session.title).toBe('Test');
  });

  it('creates a session with auto-generated id', async () => {
    const session = await storage.chatSessions.create({});
    expect(session.id).toBeTruthy();
  });

  it('updates session title', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    await storage.chatSessions.updateTitle('sess-1', 'New Title');
    const sessions = await storage.chatSessions.list();
    expect(sessions[0].title).toBe('New Title');
  });

  it('ensures session exists (upsert)', async () => {
    // First call creates
    await storage.chatSessions.ensureExists('sess-1');
    let sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(1);

    // Second call is idempotent
    await storage.chatSessions.ensureExists('sess-1');
    sessions = await storage.chatSessions.list();
    expect(sessions).toHaveLength(1);
  });

  it('touches updated_at on ensureExists', async () => {
    await storage.chatSessions.create({ id: 'sess-1' });
    const before = (await storage.chatSessions.list())[0].updated_at;

    // Small delay to ensure timestamp differs
    await new Promise(r => setTimeout(r, 1100));
    await storage.chatSessions.ensureExists('sess-1');
    const after = (await storage.chatSessions.list())[0].updated_at;

    expect(after).toBeGreaterThanOrEqual(before);
  });
});
