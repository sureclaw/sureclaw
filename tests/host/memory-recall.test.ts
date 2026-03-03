import { describe, it, expect, vi } from 'vitest';
import {
  recallMemoryForMessage,
  type MemoryRecallConfig,
} from '../../src/host/memory-recall.js';
import type { MemoryProvider, MemoryEntry, MemoryQuery } from '../../src/providers/memory/types.js';
import type { EmbeddingClient } from '../../src/utils/embedding-client.js';

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => silentLogger,
} as any;

function createMockMemory(entries: MemoryEntry[]): MemoryProvider {
  return {
    async write() { return 'id'; },
    async query(q: MemoryQuery) {
      if (!q.query) return [];
      // Simple keyword matching for testing
      return entries.filter(e =>
        q.query!.split(' OR ').some(term =>
          e.content.toLowerCase().includes(term.toLowerCase()),
        ),
      ).slice(0, q.limit ?? 50);
    },
    async read() { return null; },
    async delete() {},
    async list() { return []; },
  };
}

function createFailingMemory(): MemoryProvider {
  return {
    async write() { return 'id'; },
    async query() { throw new Error('Memory unavailable'); },
    async read() { return null; },
    async delete() {},
    async list() { return []; },
  };
}

const enabledConfig: MemoryRecallConfig = {
  enabled: true,
  limit: 5,
  scope: '*',
};

describe('recallMemoryForMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when disabled', async () => {
    const memory = createMockMemory([
      { scope: 'test', content: 'TypeScript is preferred' },
    ]);
    const result = await recallMemoryForMessage(
      'What language should I use?',
      memory,
      { ...enabledConfig, enabled: false },
      silentLogger,
    );
    expect(result).toEqual([]);
  });

  it('returns empty when no query terms extracted', async () => {
    const memory = createMockMemory([
      { scope: 'test', content: 'something' },
    ]);
    // Very short message with only stop words
    const result = await recallMemoryForMessage(
      'I am',
      memory,
      enabledConfig,
      silentLogger,
    );
    expect(result).toEqual([]);
  });

  it('returns memory context turns when matches found', async () => {
    const memory = createMockMemory([
      {
        id: 'mem1',
        scope: 'default',
        content: 'User prefers TypeScript over JavaScript',
        tags: ['preference', 'language'],
        createdAt: new Date('2026-02-28'),
      },
      {
        id: 'mem2',
        scope: 'default',
        content: 'Project uses React with TypeScript',
        tags: ['project', 'tech-stack'],
        createdAt: new Date('2026-03-01'),
      },
    ]);

    const result = await recallMemoryForMessage(
      'Which programming language should we use for the frontend?',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(result).toHaveLength(2); // user turn + assistant turn
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('Long-term memory recall');
    expect(result[0].content).toContain('TypeScript');
    expect(result[0].content).toContain('preference');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toContain('prior context');
  });

  it('returns empty when no matches found', async () => {
    const memory = createMockMemory([
      { scope: 'default', content: 'Unrelated memory about cooking pasta' },
    ]);

    const result = await recallMemoryForMessage(
      'Help me deploy the Kubernetes cluster',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(result).toEqual([]);
    expect(silentLogger.debug).toHaveBeenCalledWith(
      'memory_recall_empty',
      expect.any(Object),
    );
  });

  it('handles memory provider errors gracefully', async () => {
    const memory = createFailingMemory();

    const result = await recallMemoryForMessage(
      'What did we decide about the architecture?',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(result).toEqual([]);
    expect(silentLogger.warn).toHaveBeenCalledWith(
      'memory_recall_failed',
      expect.objectContaining({ error: 'Memory unavailable' }),
    );
  });

  it('respects the limit config', async () => {
    const entries: MemoryEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        id: `mem${i}`,
        scope: 'default',
        content: `Memory about deployment number ${i}`,
      });
    }
    const memory = createMockMemory(entries);

    const result = await recallMemoryForMessage(
      'Tell me about the deployment process',
      memory,
      { ...enabledConfig, limit: 3 },
      silentLogger,
    );

    expect(result).toHaveLength(2); // still a pair
    // The content should have at most 3 numbered entries
    const lines = result[0].content.split('\n').filter(l => /^\d+\./.test(l));
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it('logs recall hits with entry IDs', async () => {
    const memory = createMockMemory([
      { id: 'abc-123', scope: 'default', content: 'Database uses PostgreSQL' },
    ]);

    await recallMemoryForMessage(
      'What database are we using?',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(silentLogger.info).toHaveBeenCalledWith(
      'memory_recall_hit',
      expect.objectContaining({
        matchCount: 1,
        entryIds: ['abc-123'],
      }),
    );
  });

  it('formats dates in memory entries', async () => {
    const memory = createMockMemory([
      {
        scope: 'default',
        content: 'Decided to use React for the frontend',
        createdAt: new Date('2026-02-15T10:00:00Z'),
      },
    ]);

    const result = await recallMemoryForMessage(
      'What frontend framework did we choose?',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(result[0].content).toContain('2026-02-15');
  });

  it('extracts meaningful query terms from user message', async () => {
    let capturedQuery: MemoryQuery | null = null;
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query(q: MemoryQuery) {
        capturedQuery = q;
        return [];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    await recallMemoryForMessage(
      'Can you help me with the TypeScript configuration for webpack?',
      memory,
      enabledConfig,
      silentLogger,
    );

    expect(capturedQuery).not.toBeNull();
    expect(capturedQuery!.query).toContain('typescript');
    expect(capturedQuery!.query).toContain('configuration');
    expect(capturedQuery!.query).toContain('webpack');
    // Should not contain stop words
    expect(capturedQuery!.query).not.toContain(' you ');
    expect(capturedQuery!.query).not.toContain(' the ');
    expect(capturedQuery!.query).not.toContain(' can ');
  });

  it('passes scope from config to memory query', async () => {
    let capturedQuery: MemoryQuery | null = null;
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query(q: MemoryQuery) {
        capturedQuery = q;
        return [];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    await recallMemoryForMessage(
      'What about the project architecture?',
      memory,
      { ...enabledConfig, scope: 'project-notes' },
      silentLogger,
    );

    expect(capturedQuery!.scope).toBe('project-notes');
  });

  // ── Embedding-based recall tests ──

  it('uses embedding search when embeddingClient is available', async () => {
    let capturedQuery: MemoryQuery | null = null;
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query(q: MemoryQuery) {
        capturedQuery = q;
        return [{ id: 'mem1', scope: 'default', content: 'Found via embedding' }];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    const mockEmbeddingClient: EmbeddingClient = {
      available: true,
      dimensions: 3,
      async embed(texts: string[]) {
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    };

    const result = await recallMemoryForMessage(
      'What database do we use?',
      memory,
      { ...enabledConfig, embeddingClient: mockEmbeddingClient },
      silentLogger,
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toContain('Found via embedding');
    // Query should have embedding, not keyword query
    expect(capturedQuery!.embedding).toBeInstanceOf(Float32Array);
    expect(capturedQuery!.query).toBeUndefined();
  });

  it('falls back to keyword search when embedding client is unavailable', async () => {
    let capturedQuery: MemoryQuery | null = null;
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query(q: MemoryQuery) {
        capturedQuery = q;
        if (q.query) {
          return [{ id: 'mem1', scope: 'default', content: 'Found via keywords for database' }];
        }
        return [];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    const unavailableClient: EmbeddingClient = {
      available: false,
      dimensions: 3,
      async embed() { throw new Error('not available'); },
    };

    const result = await recallMemoryForMessage(
      'What database are we using?',
      memory,
      { ...enabledConfig, embeddingClient: unavailableClient },
      silentLogger,
    );

    expect(result).toHaveLength(2);
    // Should have used keyword query, not embedding
    expect(capturedQuery!.query).toBeTruthy();
    expect(capturedQuery!.embedding).toBeUndefined();
  });

  it('falls back to keyword search when embedding fails', async () => {
    let capturedQuery: MemoryQuery | null = null;
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query(q: MemoryQuery) {
        capturedQuery = q;
        if (q.query) {
          return [{ id: 'mem1', scope: 'default', content: 'Fallback keyword result for database' }];
        }
        return [];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    const failingClient: EmbeddingClient = {
      available: true,
      dimensions: 3,
      async embed() { throw new Error('API rate limited'); },
    };

    const result = await recallMemoryForMessage(
      'What database are we using?',
      memory,
      { ...enabledConfig, embeddingClient: failingClient },
      silentLogger,
    );

    // Should fall back to keyword search after embedding failure
    expect(result).toHaveLength(2);
    expect(capturedQuery!.query).toBeTruthy();
    expect(silentLogger.warn).toHaveBeenCalledWith(
      'memory_recall_embedding_failed',
      expect.objectContaining({ error: 'API rate limited', fallback: 'keyword' }),
    );
  });

  it('logs embedding strategy on recall hit', async () => {
    const memory: MemoryProvider = {
      async write() { return 'id'; },
      async query() {
        return [{ id: 'mem1', scope: 'default', content: 'Result via embedding' }];
      },
      async read() { return null; },
      async delete() {},
      async list() { return []; },
    };

    const mockClient: EmbeddingClient = {
      available: true,
      dimensions: 3,
      async embed(texts: string[]) {
        return texts.map(() => new Float32Array([0.1, 0.2, 0.3]));
      },
    };

    await recallMemoryForMessage(
      'Tell me about the architecture',
      memory,
      { ...enabledConfig, embeddingClient: mockClient },
      silentLogger,
    );

    expect(silentLogger.info).toHaveBeenCalledWith(
      'memory_recall_hit',
      expect.objectContaining({ strategy: 'embedding' }),
    );
  });

  it('works without embeddingClient at all (backward compat)', async () => {
    const memory = createMockMemory([
      { id: 'mem1', scope: 'default', content: 'Database uses PostgreSQL' },
    ]);

    const result = await recallMemoryForMessage(
      'What database are we using?',
      memory,
      enabledConfig, // no embeddingClient field
      silentLogger,
    );

    expect(result).toHaveLength(2);
    expect(result[0].content).toContain('PostgreSQL');
  });
});
