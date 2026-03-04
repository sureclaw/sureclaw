import { describe, it, expect, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const mockControl = vi.hoisted(() => ({
  shouldFailLoad: false,
}));

vi.mock('sqlite-vec', async (importOriginal) => {
  const original = await importOriginal<typeof import('sqlite-vec')>();
  return {
    ...original,
    load: (...args: Parameters<typeof original.load>) => {
      if (mockControl.shouldFailLoad) {
        throw new Error('no such module: vec0');
      }
      return original.load(...args);
    },
  };
});

// Import after vi.mock so the mock is in place
const { EmbeddingStore } = await import('../../../../src/providers/memory/memoryfs/embedding-store.js');

describe('EmbeddingStore', () => {
  let tmpDir: string;
  let store: EmbeddingStore;

  function createStore(dimensions = 3): EmbeddingStore {
    tmpDir = mkdtempSync(join(tmpdir(), 'embedding-store-test-'));
    store = new EmbeddingStore(join(tmpDir, 'test_vec.db'), dimensions);
    return store;
  }

  afterEach(async () => {
    mockControl.shouldFailLoad = false;
    if (store) await store.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes without error', async () => {
    const s = createStore();
    await s.ready();
  });

  it('upserts and checks embedding existence', async () => {
    const s = createStore();
    await s.ready();

    const vec = new Float32Array([0.1, 0.2, 0.3]);
    await s.upsert('item-1', 'default', vec);

    expect(await s.hasEmbedding('item-1')).toBe(true);
    expect(await s.hasEmbedding('item-2')).toBe(false);
  });

  it('finds similar vectors ordered by distance', async () => {
    const s = createStore();
    await s.ready();

    // Insert three vectors
    await s.upsert('item-close', 'default', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-mid', 'default', new Float32Array([0.5, 0.5, 0.5]));
    await s.upsert('item-far', 'default', new Float32Array([0.9, 0.8, 0.7]));

    // Query near the first vector
    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 3);

    expect(results.length).toBeGreaterThanOrEqual(1);
    // Closest should be item-close (exact match, distance ≈ 0)
    expect(results[0].itemId).toBe('item-close');
    expect(results[0].distance).toBeCloseTo(0, 1);

    // Results should be ordered by ascending distance
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('respects limit parameter', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-1', 'default', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-2', 'default', new Float32Array([0.4, 0.5, 0.6]));
    await s.upsert('item-3', 'default', new Float32Array([0.7, 0.8, 0.9]));

    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters by scope', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-a', 'project-a', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-b', 'project-b', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-c', 'project-a', new Float32Array([0.4, 0.5, 0.6]));

    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10, 'project-a');

    expect(results.every(r => r.itemId.startsWith('item-a') || r.itemId.startsWith('item-c'))).toBe(true);
    expect(results.some(r => r.itemId === 'item-b')).toBe(false);
  });

  it('returns all items when scope is *', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-a', 'scope-1', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-b', 'scope-2', new Float32Array([0.4, 0.5, 0.6]));

    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10, '*');
    expect(results.length).toBe(2);
  });

  it('deletes embeddings', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-1', 'default', new Float32Array([0.1, 0.2, 0.3]));
    expect(await s.hasEmbedding('item-1')).toBe(true);

    await s.delete('item-1');
    expect(await s.hasEmbedding('item-1')).toBe(false);

    // Search should return nothing
    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10);
    expect(results.find(r => r.itemId === 'item-1')).toBeUndefined();
  });

  it('updates embedding on duplicate upsert', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-1', 'default', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('item-1', 'default', new Float32Array([0.9, 0.8, 0.7]));

    // Query near the updated vector — should find item-1
    const results = await s.findSimilar(new Float32Array([0.9, 0.8, 0.7]), 1);
    expect(results.length).toBe(1);
    expect(results[0].itemId).toBe('item-1');
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('lists unembedded items', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-1', 'default', new Float32Array([0.1, 0.2, 0.3]));
    // item-2 and item-3 have no embedding

    const unembedded = await s.listUnembedded(['item-1', 'item-2', 'item-3']);
    expect(unembedded).toEqual(['item-2', 'item-3']);
  });

  it('returns empty for empty allItemIds', async () => {
    const s = createStore();
    await s.ready();

    const unembedded = await s.listUnembedded([]);
    expect(unembedded).toEqual([]);
  });

  it('scoped search finds correct within-scope nearest neighbors', async () => {
    const s = createStore();
    await s.ready();

    // Insert items: scope-a has a vector far from query, scope-b has vectors close to query
    // The old global-MATCH-then-filter approach would miss scope-a's nearest neighbor
    // if scope-b items filled the global top-k first
    const query = new Float32Array([0.1, 0.2, 0.3]);

    // Scope A: one close item and one far item
    await s.upsert('a-close', 'scope-a', new Float32Array([0.1, 0.2, 0.3]));
    await s.upsert('a-far', 'scope-a', new Float32Array([0.9, 0.8, 0.7]));

    // Scope B: many items closer to query than a-far (to dominate global top-k)
    for (let i = 0; i < 10; i++) {
      await s.upsert(`b-${i}`, 'scope-b', new Float32Array([
        0.1 + i * 0.01,
        0.2 + i * 0.01,
        0.3 + i * 0.01,
      ]));
    }

    // Scoped search for scope-a should return both scope-a items
    const results = await s.findSimilar(query, 10, 'scope-a');
    expect(results).toHaveLength(2);
    expect(results.every(r => r.itemId.startsWith('a-'))).toBe(true);
    // Closest should be a-close
    expect(results[0].itemId).toBe('a-close');
    expect(results[0].distance).toBeCloseTo(0, 1);
  });

  it('scoped search returns empty for scope with no embeddings', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-1', 'scope-a', new Float32Array([0.1, 0.2, 0.3]));

    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10, 'scope-nonexistent');
    expect(results).toEqual([]);
  });

  // ── userId scoping tests ──

  it('upsert stores userId in embedding_meta', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-alice', 'default', new Float32Array([0.1, 0.2, 0.3]), 'alice');
    await s.upsert('item-shared', 'default', new Float32Array([0.4, 0.5, 0.6]));

    expect(await s.hasEmbedding('item-alice')).toBe(true);
    expect(await s.hasEmbedding('item-shared')).toBe(true);
  });

  it('findSimilar with userId returns own + shared items', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-alice', 'project', new Float32Array([0.1, 0.2, 0.3]), 'alice');
    await s.upsert('item-shared', 'project', new Float32Array([0.15, 0.25, 0.35])); // no userId = shared
    await s.upsert('item-bob', 'project', new Float32Array([0.12, 0.22, 0.32]), 'bob');

    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10, 'project', 'alice');

    const ids = results.map(r => r.itemId);
    expect(ids).toContain('item-alice');
    expect(ids).toContain('item-shared');
    expect(ids).not.toContain('item-bob');
  });

  it('findSimilar without userId returns all items (no user filter) in scoped query', async () => {
    const s = createStore();
    await s.ready();

    await s.upsert('item-alice', 'project', new Float32Array([0.1, 0.2, 0.3]), 'alice');
    await s.upsert('item-shared', 'project', new Float32Array([0.15, 0.25, 0.35]));
    await s.upsert('item-bob', 'project', new Float32Array([0.12, 0.22, 0.32]), 'bob');

    // Without userId, scoped query returns all items in that scope
    const results = await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10, 'project');

    expect(results).toHaveLength(3);
  });

  describe('graceful degradation when vec0 is unavailable', () => {
    it('does not throw when sqlite-vec fails to load', async () => {
      mockControl.shouldFailLoad = true;

      const s = createStore();
      // Should NOT throw — degrades gracefully
      await s.ready();
      expect(s.available).toBe(false);
    });

    it('returns safe defaults when unavailable', async () => {
      mockControl.shouldFailLoad = true;

      const s = createStore();
      await s.ready();

      // All methods should return safe no-op values
      await s.upsert('item-1', 'default', new Float32Array([0.1, 0.2, 0.3]));
      expect(await s.hasEmbedding('item-1')).toBe(false);
      expect(await s.findSimilar(new Float32Array([0.1, 0.2, 0.3]), 10)).toEqual([]);
      expect(await s.listUnembedded(['item-1', 'item-2'])).toEqual([]);
      await s.delete('item-1'); // should not throw
      await s.close(); // should not throw
    });
  });
});
