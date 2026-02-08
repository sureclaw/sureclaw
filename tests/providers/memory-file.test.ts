import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/memory-file.js';
import { rmSync } from 'node:fs';
import type { MemoryProvider, Config } from '../../src/providers/types.js';

const config = {} as Config;
const MEMORY_DIR = 'data/memory';

describe('memory-file', () => {
  let memory: MemoryProvider;

  beforeEach(async () => {
    try { rmSync(MEMORY_DIR, { recursive: true }); } catch {}
    memory = await create(config);
  });

  afterEach(() => {
    try { rmSync(MEMORY_DIR, { recursive: true }); } catch {}
  });

  test('writes and reads an entry', async () => {
    const id = await memory.write({ scope: 'user_alice', content: 'Prefers dark mode' });
    expect(id).toMatch(/^[a-f0-9-]{36}$/);

    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('Prefers dark mode');
  });

  test('queries by scope and content', async () => {
    await memory.write({ scope: 'user_alice', content: 'Likes TypeScript' });
    await memory.write({ scope: 'user_alice', content: 'Uses Vim' });
    await memory.write({ scope: 'user_bob', content: 'Likes Python' });

    const results = await memory.query({ scope: 'user_alice', query: 'typescript' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Likes TypeScript');
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

  test('rejects invalid memory IDs', async () => {
    await expect(memory.read('../../etc/passwd')).rejects.toThrow('Invalid memory ID');
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
});
