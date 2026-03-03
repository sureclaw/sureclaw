// tests/providers/memory/memoryfs/semantic-dedup.test.ts
// Separate file because vi.mock for embedding-client is hoisted and would
// affect all tests if co-located in provider.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Config } from '../../../../src/types.js';

// Hoisted mock control — survives vi.mock hoisting
const mockControl = vi.hoisted(() => ({
  available: true,
  vectors: new Map<string, Float32Array>(),
  shouldThrow: false,
  callCount: 0,
}));

vi.mock('../../../../src/utils/embedding-client.js', () => ({
  createEmbeddingClient: () => ({
    available: mockControl.available,
    dimensions: 3,
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (mockControl.shouldThrow) throw new Error('embed failed');
      mockControl.callCount++;
      return texts.map(t => {
        const vec = mockControl.vectors.get(t);
        if (!vec) throw new Error(`No mock vector for: ${t}`);
        return vec;
      });
    },
  }),
}));

// Import after vi.mock so the mock is in place
const { create } = await import('../../../../src/providers/memory/memoryfs/provider.js');

const config = {
  history: { embedding_model: 'mock/test', embedding_dimensions: 3 },
} as unknown as Config;

describe('semantic dedup in write()', () => {
  let testHome: string;

  beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), `memfs-semdedup-${randomUUID()}-`));
    process.env.AX_HOME = testHome;
    mockControl.available = true;
    mockControl.vectors.clear();
    mockControl.shouldThrow = false;
    mockControl.callCount = 0;
  });

  afterEach(async () => {
    try { await rm(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  it('deduplicates semantically similar content', async () => {
    // Two different strings that map to the same vector → semantic match
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    mockControl.vectors.set('User uses TypeScript for all projects', vec);
    mockControl.vectors.set('The user uses TypeScript for all their projects', vec);

    const memory = await create(config);

    const id1 = await memory.write({
      scope: 'default',
      content: 'User uses TypeScript for all projects',
    });
    // Wait for the fire-and-forget embedding upsert to complete
    await new Promise(r => setTimeout(r, 50));
    const id2 = await memory.write({
      scope: 'default',
      content: 'The user uses TypeScript for all their projects',
    });

    expect(id2).toBe(id1);
    const entries = await memory.list('default');
    expect(entries).toHaveLength(1);
  });

  it('stores both items when vectors are distant', async () => {
    mockControl.vectors.set('User prefers dark mode', new Float32Array([0.1, 0.2, 0.3]));
    mockControl.vectors.set('Project uses PostgreSQL', new Float32Array([0.9, 0.1, 0.5]));

    const memory = await create(config);

    const id1 = await memory.write({ scope: 'default', content: 'User prefers dark mode' });
    const id2 = await memory.write({ scope: 'default', content: 'Project uses PostgreSQL' });

    expect(id2).not.toBe(id1);
    const entries = await memory.list('default');
    expect(entries).toHaveLength(2);
  });

  it('falls back to hash-only dedup when embeddings unavailable', async () => {
    mockControl.available = false;

    const memory = await create(config);

    const id1 = await memory.write({ scope: 'default', content: 'Uses TypeScript' });
    const id2 = await memory.write({ scope: 'default', content: 'Uses TypeScript' });

    // Hash dedup still works
    expect(id2).toBe(id1);
    expect(mockControl.callCount).toBe(0);
  });

  it('gracefully handles embed() errors and still stores item', async () => {
    mockControl.shouldThrow = true;

    const memory = await create(config);

    // Should not throw — falls through to insert
    const id = await memory.write({ scope: 'default', content: 'Some fact' });
    expect(id).toBeTruthy();

    const entry = await memory.read(id);
    expect(entry).not.toBeNull();
    expect(entry!.content).toBe('Some fact');
  });

  it('reuses precomputed vector (embed called once per write, not twice)', async () => {
    mockControl.vectors.set('First fact', new Float32Array([0.1, 0.2, 0.3]));

    const memory = await create(config);

    await memory.write({ scope: 'default', content: 'First fact' });
    // Wait for async embedding upsert to settle
    await new Promise(r => setTimeout(r, 50));

    // embed() should be called exactly once (for dedup check), not twice (dedup + store)
    expect(mockControl.callCount).toBe(1);
  });

  it('isolates semantic dedup by scope', async () => {
    const vec = new Float32Array([0.1, 0.2, 0.3]);
    mockControl.vectors.set('Same content', vec);

    const memory = await create(config);

    const id1 = await memory.write({ scope: 'scope-a', content: 'Same content' });
    const id2 = await memory.write({ scope: 'scope-b', content: 'Same content' });

    // Different scopes → both stored even with identical vectors
    expect(id2).not.toBe(id1);

    const a = await memory.list('scope-a');
    const b = await memory.list('scope-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
