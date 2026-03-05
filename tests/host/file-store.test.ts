import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileStore } from '../../src/file-store.js';
import { createKyselyDb } from '../../src/utils/database.js';
import { runMigrations } from '../../src/utils/migrator.js';
import { filesMigrations } from '../../src/migrations/files.js';
import type { Kysely } from 'kysely';

describe('FileStore', () => {
  let store: FileStore;
  let tmpDir: string;
  let db: Kysely<any>;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-filestore-'));
    db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'files.db') });
    const result = await runMigrations(db, filesMigrations);
    if (result.error) throw result.error;
    store = new FileStore(db);
  });

  afterEach(async () => {
    await store.close();
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('register and lookup a file', async () => {
    await store.register('generated-abc.png', 'main', 'user1', 'image/png');
    const entry = await store.lookup('generated-abc.png');
    expect(entry).toBeDefined();
    expect(entry!.fileId).toBe('generated-abc.png');
    expect(entry!.agentName).toBe('main');
    expect(entry!.userId).toBe('user1');
    expect(entry!.mimeType).toBe('image/png');
  });

  test('lookup returns undefined for unknown fileId', async () => {
    const entry = await store.lookup('nonexistent.png');
    expect(entry).toBeUndefined();
  });

  test('register with subdirectory fileId', async () => {
    await store.register('files/chart-001.png', 'main', 'vinay@example.com', 'image/png');
    const entry = await store.lookup('files/chart-001.png');
    expect(entry).toBeDefined();
    expect(entry!.agentName).toBe('main');
    expect(entry!.userId).toBe('vinay@example.com');
  });

  test('register overwrites existing entry for same fileId', async () => {
    await store.register('img.png', 'agent1', 'user1', 'image/png');
    await store.register('img.png', 'agent2', 'user2', 'image/jpeg');
    const entry = await store.lookup('img.png');
    expect(entry!.agentName).toBe('agent2');
    expect(entry!.userId).toBe('user2');
    expect(entry!.mimeType).toBe('image/jpeg');
  });
});
