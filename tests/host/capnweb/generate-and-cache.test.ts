/**
 * Tests for tool stub generation + DB caching.
 */

import { describe, it, expect } from 'vitest';
import { computeSchemaHash } from '../../../src/providers/storage/tool-stubs.js';
import { prepareToolStubs } from '../../../src/host/capnweb/generate-and-cache.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import type { DocumentStore } from '../../../src/providers/storage/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

// ---------------------------------------------------------------------------
// In-memory DocumentStore for testing
// ---------------------------------------------------------------------------

function createMemoryDocStore(): DocumentStore {
  const store = new Map<string, Map<string, string>>();

  return {
    async get(collection, key) {
      return store.get(collection)?.get(key);
    },
    async put(collection, key, content) {
      if (!store.has(collection)) store.set(collection, new Map());
      store.get(collection)!.set(key, content);
    },
    async delete(collection, key) {
      return store.get(collection)?.delete(key) ?? false;
    },
    async list(collection) {
      return [...(store.get(collection)?.keys() ?? [])];
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const TOOLS: McpToolSchema[] = [
  {
    name: 'getTeams',
    description: 'Get teams',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' } } },
  },
  {
    name: 'getIssues',
    description: 'Get issues',
    inputSchema: { type: 'object', properties: { teamId: { type: 'string' } }, required: ['teamId'] },
  },
];

describe('computeSchemaHash', () => {
  it('should produce deterministic hash', () => {
    const h1 = computeSchemaHash(TOOLS);
    const h2 = computeSchemaHash(TOOLS);
    expect(h1).toBe(h2);
  });

  it('should be order-independent', () => {
    const h1 = computeSchemaHash([TOOLS[0], TOOLS[1]]);
    const h2 = computeSchemaHash([TOOLS[1], TOOLS[0]]);
    expect(h1).toBe(h2);
  });

  it('should change when tools change', () => {
    const h1 = computeSchemaHash(TOOLS);
    const h2 = computeSchemaHash([TOOLS[0]]);
    expect(h1).not.toBe(h2);
  });
});

describe('prepareToolStubs', () => {
  it('should return null when no tools configured', async () => {
    const result = await prepareToolStubs({
      agentName: 'test',
      tools: [],
    });
    expect(result).toBeNull();
  });

  it('should generate stubs with correct files', async () => {
    const files = await prepareToolStubs({
      agentName: 'test',
      tools: TOOLS,
    });

    expect(files).not.toBeNull();
    const paths = files!.map(f => f.path);
    expect(paths).toContain('_runtime.ts');
    // Tools are ungrouped (no prefix separator) → 'default' server
    expect(paths.some(p => p.includes('getTeams.ts'))).toBe(true);
    expect(paths.some(p => p.includes('getIssues.ts'))).toBe(true);
  });

  it('should cache stubs in DocumentStore', async () => {
    const docs = createMemoryDocStore();

    // First call: generates and caches
    const files1 = await prepareToolStubs({
      documents: docs,
      agentName: 'main',
      tools: TOOLS,
    });

    // Verify cache was written
    const cached = await docs.get('tool-stubs', 'main');
    expect(cached).toBeDefined();
    const parsed = JSON.parse(cached!);
    expect(parsed.schemaHash).toBe(computeSchemaHash(TOOLS));
    expect(parsed.files).toHaveLength(files1!.length);

    // Second call with same tools: cache hit (returns same files)
    const files2 = await prepareToolStubs({
      documents: docs,
      agentName: 'main',
      tools: TOOLS,
    });

    expect(files2).toEqual(files1);
  });

  it('should regenerate when tools change', async () => {
    const docs = createMemoryDocStore();

    // Generate with 2 tools
    await prepareToolStubs({
      documents: docs,
      agentName: 'main',
      tools: TOOLS,
    });

    // Change tools — should regenerate
    const files = await prepareToolStubs({
      documents: docs,
      agentName: 'main',
      tools: [TOOLS[0]], // only 1 tool now
    });

    expect(files).not.toBeNull();
    // Verify cache was updated with new hash
    const cached = JSON.parse((await docs.get('tool-stubs', 'main'))!);
    expect(cached.schemaHash).toBe(computeSchemaHash([TOOLS[0]]));
  });

  it('should work without DocumentStore (no caching)', async () => {
    const files = await prepareToolStubs({
      agentName: 'test',
      tools: TOOLS,
      // No documents — just generates, no caching
    });

    expect(files).not.toBeNull();
    expect(files!.length).toBeGreaterThan(0);
  });
});
