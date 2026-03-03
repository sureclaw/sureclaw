import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createEmbeddingClient } from '../../src/utils/embedding-client.js';

// Shared mock create function so we can control its return value per test
const mockCreate = vi.fn().mockResolvedValue({
  data: [
    { index: 0, embedding: [0.1, 0.2, 0.3] },
  ],
});

// Mock the OpenAI SDK
vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      embeddings = { create: mockCreate };
    },
  };
});

describe('createEmbeddingClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreate.mockResolvedValue({
      data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }],
    });
  });

  it('returns available=false when no API key', () => {
    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: undefined,
    });
    expect(client.available).toBe(false);
    expect(client.dimensions).toBe(3);
  });

  it('throws when calling embed() without API key', async () => {
    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: undefined,
    });
    await expect(client.embed(['hello'])).rejects.toThrow('OPENAI_API_KEY not set');
  });

  it('returns available=true when API key is set', () => {
    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: 'sk-test-key',
    });
    expect(client.available).toBe(true);
    expect(client.dimensions).toBe(3);
  });

  it('returns Float32Array from embed()', async () => {
    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: 'sk-test-key',
    });
    const result = await client.embed(['hello world']);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0].length).toBe(3);
  });

  it('returns empty array for empty input', async () => {
    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: 'sk-test-key',
    });
    const result = await client.embed([]);
    expect(result).toEqual([]);
  });

  it('sorts results by index to match input order', async () => {
    mockCreate.mockResolvedValue({
      data: [
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ],
    });

    const client = createEmbeddingClient({
      model: 'text-embedding-3-small',
      dimensions: 3,
      apiKey: 'sk-test-key',
    });
    const result = await client.embed(['first', 'second']);

    // Even though API returned index 1 first, results should be reordered
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Float32Array);
    // First result should be [0.1, 0.2, 0.3] (index 0)
    expect(Array.from(result[0])).toEqual([
      expect.closeTo(0.1, 1),
      expect.closeTo(0.2, 1),
      expect.closeTo(0.3, 1),
    ]);
  });
});
