import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/memory/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import type { MemoryProvider, Config } from '../../src/providers/types.js';

const config = {} as Config;
const DB_PATH = 'data/memory.db';

function cleanDb() {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + '-wal'); } catch {}
  try { rmSync(DB_PATH + '-shm'); } catch {}
}

describe('memory-sqlite', () => {
  let memory: MemoryProvider;

  beforeEach(async () => {
    cleanDb();
    mkdirSync('data', { recursive: true });
    memory = await create(config);
  });

  afterEach(() => {
    cleanDb();
  });

  test('writes and reads an entry', async () => {
    const id = await memory.write({ scope: 'user_alice', content: 'Prefers dark mode' });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);

    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('Prefers dark mode');
    expect(entry!.scope).toBe('user_alice');
  });

  test('writes with explicit ID', async () => {
    const explicitId = '12345678-1234-1234-1234-123456789abc';
    const id = await memory.write({ id: explicitId, scope: 'test', content: 'hello' });
    expect(id).toBe(explicitId);

    const entry = await memory.read(explicitId);
    expect(entry!.content).toBe('hello');
  });

  test('queries by scope with FTS5', async () => {
    await memory.write({ scope: 'user_alice', content: 'Likes TypeScript programming' });
    await memory.write({ scope: 'user_alice', content: 'Uses Vim editor' });
    await memory.write({ scope: 'user_bob', content: 'Likes Python programming' });

    const results = await memory.query({ scope: 'user_alice', query: 'TypeScript' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Likes TypeScript programming');
  });

  test('queries without text return all in scope', async () => {
    await memory.write({ scope: 'user_alice', content: 'Entry 1' });
    await memory.write({ scope: 'user_alice', content: 'Entry 2' });
    await memory.write({ scope: 'user_bob', content: 'Entry 3' });

    const results = await memory.query({ scope: 'user_alice' });
    expect(results).toHaveLength(2);
  });

  test('queries filter by tags', async () => {
    await memory.write({ scope: 'test', content: 'Tagged entry', tags: ['important', 'work'] });
    await memory.write({ scope: 'test', content: 'Other entry', tags: ['personal'] });

    const results = await memory.query({ scope: 'test', tags: ['important'] });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Tagged entry');
  });

  test('lists entries in scope', async () => {
    await memory.write({ scope: 'user_alice', content: 'Entry 1' });
    await memory.write({ scope: 'user_alice', content: 'Entry 2' });

    const entries = await memory.list('user_alice');
    expect(entries).toHaveLength(2);
  });

  test('deletes an entry', async () => {
    const id = await memory.write({ scope: 'user_alice', content: 'Delete me' });
    await memory.delete(id);
    const entry = await memory.read(id);
    expect(entry).toBeNull();
  });

  test('returns null for non-existent entry', async () => {
    const entry = await memory.read('00000000-0000-0000-0000-000000000000');
    expect(entry).toBeNull();
  });

  test('respects query limit', async () => {
    for (let i = 0; i < 5; i++) {
      await memory.write({ scope: 'test', content: `Entry ${i}` });
    }
    const results = await memory.query({ scope: 'test', limit: 2 });
    expect(results).toHaveLength(2);
  });

  test('preserves taint tags', async () => {
    const taint = { source: 'slack', trust: 'external' as const, timestamp: new Date() };
    const id = await memory.write({ scope: 'test', content: 'External data', taint });

    const entry = await memory.read(id);
    expect(entry!.taint).toBeDefined();
    expect(entry!.taint!.source).toBe('slack');
    expect(entry!.taint!.trust).toBe('external');
  });
});
