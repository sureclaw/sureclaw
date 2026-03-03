// tests/providers/memory/memoryfs/provider.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../../src/providers/memory/memoryfs/provider.js';
import type { MemoryProvider, ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { Config } from '../../../../src/types.js';

const config = {} as Config;

describe('memoryfs provider', () => {
  let memory: MemoryProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-provider-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
    memory = await create(config);
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('write() stores an entry and returns an id', async () => {
    const id = await memory.write({
      scope: 'default',
      content: 'The API uses REST with JWT auth',
    });
    expect(id).toBeTruthy();
    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('The API uses REST with JWT auth');
  });

  it('read() returns null for non-existent id', async () => {
    const entry = await memory.read(randomUUID());
    expect(entry).toBeNull();
  });

  it('query() finds entries by text match', async () => {
    await memory.write({ scope: 'default', content: 'Prefers TypeScript over JavaScript' });
    await memory.write({ scope: 'default', content: 'Uses PostgreSQL in production' });
    const results = await memory.query({ scope: 'default', query: 'TypeScript' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('TypeScript');
  });

  it('query() respects scope isolation', async () => {
    await memory.write({ scope: 'project-a', content: 'Uses React' });
    await memory.write({ scope: 'project-b', content: 'Uses Vue' });
    const results = await memory.query({ scope: 'project-a' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('React');
  });

  it('query() respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await memory.write({ scope: 'default', content: `Fact number ${i}` });
    }
    const results = await memory.query({ scope: 'default', limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('list() returns entries for scope', async () => {
    await memory.write({ scope: 'default', content: 'Fact one' });
    await memory.write({ scope: 'default', content: 'Fact two' });
    const entries = await memory.list('default');
    expect(entries).toHaveLength(2);
  });

  it('delete() removes an entry', async () => {
    const id = await memory.write({ scope: 'default', content: 'To be deleted' });
    await memory.delete(id);
    const entry = await memory.read(id);
    expect(entry).toBeNull();
  });

  it('memorize() extracts facts from conversation', async () => {
    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer dark mode in all editors' },
      { role: 'assistant', content: 'Got it, I will remember that.' },
    ];
    await memory.memorize!(conversation);
    const results = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it('memorize() deduplicates and reinforces', async () => {
    const conv1: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ];
    const conv2: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ];
    await memory.memorize!(conv1);
    await memory.memorize!(conv2);
    const results = await memory.query({ scope: 'default', query: 'TypeScript' });
    expect(results).toHaveLength(1);
  });

  it('preserves taint tags', async () => {
    const id = await memory.write({
      scope: 'default',
      content: 'External fact',
      taint: { source: 'web', trust: 'external', timestamp: new Date() },
    });
    const entry = await memory.read(id);
    expect(entry!.taint).toBeTruthy();
    expect(entry!.taint!.trust).toBe('external');
  });

  it('filters by agentId', async () => {
    await memory.write({ scope: 'default', content: 'Agent 1 fact', agentId: 'a1' });
    await memory.write({ scope: 'default', content: 'Agent 2 fact', agentId: 'a2' });
    const results = await memory.query({ scope: 'default', agentId: 'a1' });
    expect(results).toHaveLength(1);
    expect(results[0].content).toContain('Agent 1');
  });

  it('query() with embedding returns empty when no items exist, not unfiltered listing', async () => {
    // Write some items to the store (keyword-searchable)
    await memory.write({ scope: 'default', content: 'Some keyword-searchable fact' });
    await memory.write({ scope: 'default', content: 'Another fact in the store' });

    // Query with an embedding vector but for a scope with no embeddings
    // Should return empty — not fall through to keyword/listing search
    const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3]);
    const results = await memory.query({
      scope: 'nonexistent-scope',
      embedding: fakeEmbedding,
    });
    expect(results).toEqual([]);
  });
});
