// tests/providers/memory/cortex/provider.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { create } from '../../../../src/providers/memory/cortex/provider.js';
import type { MemoryProvider, ConversationTurn } from '../../../../src/providers/memory/types.js';
import type { Config } from '../../../../src/types.js';
import type { LLMProvider, ChatChunk } from '../../../../src/providers/llm/types.js';
import { dataFile } from '../../../../src/paths.js';
import { SUMMARY_ID_PREFIX } from '../../../../src/providers/memory/cortex/summary-store.js';

const config = {} as Config;

/** Create an async iterable from an array of chunks. */
async function* chunksFrom(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c;
}

/** Build a mock LLM that returns canned responses per call index. */
function mockLLM(responses: string[]): LLMProvider {
  let callIdx = 0;
  return {
    name: 'mock',
    chat: vi.fn().mockImplementation(() => {
      const resp = responses[callIdx] ?? responses[responses.length - 1];
      callIdx++;
      return chunksFrom([
        { type: 'text', content: resp },
        { type: 'done' },
      ]);
    }),
    models: vi.fn().mockResolvedValue(['fast']),
  };
}

describe('cortex provider', () => {
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

  it('memorize() throws when no LLM is available', async () => {
    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer dark mode in all editors' },
    ];
    await expect(memory.memorize!(conversation)).rejects.toThrow('memorize requires an LLM provider');
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

  // ── userId scoping tests ──

  it('write() with userId stores user-scoped entry', async () => {
    const id = await memory.write({
      scope: 'default',
      content: 'Alice prefers dark mode',
      userId: 'alice',
    });
    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.userId).toBe('alice');
  });

  it('query() with userId returns own + shared', async () => {
    await memory.write({ scope: 'default', content: 'Alice fact about TypeScript', userId: 'alice' });
    await memory.write({ scope: 'default', content: 'Shared fact about TypeScript' }); // no userId = shared
    await memory.write({ scope: 'default', content: 'Bob fact about TypeScript', userId: 'bob' });

    const results = await memory.query({ scope: 'default', query: 'TypeScript', userId: 'alice' });
    expect(results).toHaveLength(2);
    const contents = results.map(r => r.content);
    expect(contents).toContain('Alice fact about TypeScript');
    expect(contents).toContain('Shared fact about TypeScript');
    expect(contents).not.toContain('Bob fact about TypeScript');
  });

  it('query() without userId returns all items', async () => {
    await memory.write({ scope: 'default', content: 'Alice fact about React', userId: 'alice' });
    await memory.write({ scope: 'default', content: 'Shared fact about React' });
    await memory.write({ scope: 'default', content: 'Bob fact about React', userId: 'bob' });

    const results = await memory.query({ scope: 'default', query: 'React' });
    expect(results).toHaveLength(3);
  });

  it('list() with userId returns own + shared', async () => {
    await memory.write({ scope: 'default', content: 'Alice memory', userId: 'alice' });
    await memory.write({ scope: 'default', content: 'Shared memory' });
    await memory.write({ scope: 'default', content: 'Bob memory', userId: 'bob' });

    const entries = await memory.list('default', undefined, 'alice');
    expect(entries).toHaveLength(2);
    const contents = entries.map(e => e.content);
    expect(contents).toContain('Alice memory');
    expect(contents).toContain('Shared memory');
  });

  it('hash dedup scopes by userId (same content, different users = separate entries)', async () => {
    const id1 = await memory.write({ scope: 'default', content: 'Prefers TypeScript', userId: 'alice' });
    const id2 = await memory.write({ scope: 'default', content: 'Prefers TypeScript', userId: 'bob' });

    // Both should be separate entries
    expect(id1).not.toBe(id2);
    const entry1 = await memory.read(id1);
    const entry2 = await memory.read(id2);
    expect(entry1).not.toBeNull();
    expect(entry2).not.toBeNull();
    expect(entry1!.userId).toBe('alice');
    expect(entry2!.userId).toBe('bob');
  });

  it('query() does not append summaries when limit is filled by items', async () => {
    const mem = await create(config);

    for (let i = 0; i < 5; i++) {
      await mem.write({ scope: 'default', content: `Fact ${i} about TypeScript` });
    }

    const results = await mem.query({ scope: 'default', query: 'TypeScript', limit: 5 });
    expect(results).toHaveLength(5);
    expect(results.every(r => !r.id?.startsWith(SUMMARY_ID_PREFIX))).toBe(true);
  });

  it('query() does not append summaries for embedding queries', async () => {
    const mem = await create(config);
    await mem.write({ scope: 'default', content: 'Some fact' });

    const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3]);
    const results = await mem.query({
      scope: 'default',
      embedding: fakeEmbedding,
      limit: 10,
    });
    expect(results.every(r => !r.id?.startsWith(SUMMARY_ID_PREFIX))).toBe(true);
  });

  it('read() returns null for summary IDs', async () => {
    const mem = await create(config);
    const entry = await mem.read(`${SUMMARY_ID_PREFIX}preferences`);
    expect(entry).toBeNull();
  });

  it('delete() is a no-op for summary IDs', async () => {
    const mem = await create(config);
    await mem.delete(`${SUMMARY_ID_PREFIX}preferences`);
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

describe('cortex provider with LLM', () => {
  let memory: MemoryProvider;
  let testHome: string;
  let llm: LLMProvider;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-llm-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('write() gives explicit entries reinforcementCount=10', async () => {
    // Use a summary response for the fire-and-forget update
    llm = mockLLM(['# knowledge\n## Facts\n- REST API with JWT auth']);
    memory = await create(config, undefined, { llm });

    const id = await memory.write({
      scope: 'default',
      content: 'The API uses REST with JWT auth',
    });
    expect(id).toBeTruthy();

    // Verify the entry exists and is queryable
    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('The API uses REST with JWT auth');
  });

  it('write() triggers LLM summary update', async () => {
    llm = mockLLM(['# knowledge\n## Updated\n- API uses REST with JWT']);
    memory = await create(config, undefined, { llm });

    await memory.write({
      scope: 'default',
      content: 'The API uses REST with JWT auth',
    });

    // Wait for fire-and-forget summary update
    await new Promise(r => setTimeout(r, 50));

    expect(llm.chat).toHaveBeenCalled();
    // Verify summary file was updated with LLM content
    const memoryDir = dataFile('memory');
    const summary = await readFile(join(memoryDir, 'knowledge.md'), 'utf-8');
    expect(summary).toContain('REST');
  });

  it('memorize() uses LLM extraction when LLM available', async () => {
    const extractionResponse = JSON.stringify([
      { content: 'User prefers dark mode', memoryType: 'profile', category: 'preferences' },
    ]);
    const summaryResponse = '# preferences\n## UI\n- Prefers dark mode in editors';
    llm = mockLLM([extractionResponse, summaryResponse]);
    memory = await create(config, undefined, { llm });

    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'I prefer dark mode in all editors' },
      { role: 'assistant', content: 'Got it!' },
    ];
    await memory.memorize!(conversation);

    // LLM chat should have been called (extraction + summary)
    expect(llm.chat).toHaveBeenCalled();

    // Verify the extracted item is in the store
    const results = await memory.query({ scope: 'default', query: 'dark mode' });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toBe('User prefers dark mode');
  });

  it('memorize() throws when LLM extraction fails', async () => {
    // LLM returns invalid response — error should propagate
    llm = mockLLM(['this is not valid JSON']);
    memory = await create(config, undefined, { llm });

    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'Remember that I prefer TypeScript' },
    ];
    await expect(memory.memorize!(conversation)).rejects.toThrow('LLM extraction returned no JSON array');
  });

  it('query() appends summaries after items when slots remain', async () => {
    const llmForSummary = mockLLM(['# knowledge\n## Facts\n- REST API']);
    const mem = await create(config, undefined, { llm: llmForSummary });

    await mem.write({ scope: 'default', content: 'Uses REST API' });
    await new Promise(r => setTimeout(r, 50));

    const results = await mem.query({ scope: 'default', query: 'REST', limit: 10 });
    expect(results.length).toBeGreaterThan(1);
    expect(results[0].content).toBe('Uses REST API');

    const summaryResult = results.find(r => r.id?.startsWith(SUMMARY_ID_PREFIX));
    expect(summaryResult).toBeDefined();
    expect(summaryResult!.content).toContain('REST');
  });

  it('memorize() updates summary via LLM when available', async () => {
    const extractionResponse = JSON.stringify([
      { content: 'Works at Acme Corp', memoryType: 'knowledge', category: 'work_life' },
    ]);
    const summaryResponse = '# work_life\n## Employment\n- Works at Acme Corp';
    llm = mockLLM([extractionResponse, summaryResponse]);
    memory = await create(config, undefined, { llm });

    const conversation: ConversationTurn[] = [
      { role: 'user', content: 'I work at Acme Corp' },
    ];
    await memory.memorize!(conversation);

    const memoryDir = dataFile('memory');
    const summary = await readFile(join(memoryDir, 'work_life.md'), 'utf-8');
    expect(summary).toContain('Acme Corp');
  });
});
