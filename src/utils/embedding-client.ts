/**
 * EmbeddingClient — Standalone utility for generating text embeddings.
 *
 * Wraps OpenAI's embeddings.create() endpoint. Not an LLM provider —
 * embeddings are request/response, not streaming chat.
 *
 * Gracefully degrades when no API key is set (available = false).
 */

import OpenAI from 'openai';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'embedding-client' });

export interface EmbeddingClientConfig {
  /** Model name (e.g. 'text-embedding-3-small'). */
  model: string;
  /** Output dimensions (e.g. 1536 for text-embedding-3-small). */
  dimensions: number;
  /** Override API key (defaults to OPENAI_API_KEY env var). */
  apiKey?: string;
  /** Override base URL (defaults to https://api.openai.com/v1). */
  baseUrl?: string;
}

export interface EmbeddingClient {
  /** Generate embeddings for one or more texts. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Embedding vector dimensions. */
  readonly dimensions: number;
  /** Whether the client has valid credentials and can make requests. */
  readonly available: boolean;
}

/**
 * Create an embedding client. Returns a client with available=false
 * when no API key is found — no throw, no crash, just graceful fallback.
 */
export function createEmbeddingClient(config: EmbeddingClientConfig): EmbeddingClient {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY;

  if (!apiKey) {
    logger.debug('no_api_key', { model: config.model, hint: 'Set OPENAI_API_KEY for embedding support' });
    return {
      async embed(): Promise<Float32Array[]> {
        throw new Error('EmbeddingClient: OPENAI_API_KEY not set');
      },
      dimensions: config.dimensions,
      available: false,
    };
  }

  const baseURL = config.baseUrl ?? process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const client = new OpenAI({ apiKey, baseURL });

  return {
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];

      logger.debug('embed_request', { model: config.model, count: texts.length });

      const response = await client.embeddings.create({
        model: config.model,
        input: texts,
        dimensions: config.dimensions,
        encoding_format: 'float',
      });

      // Sort by index to match input order (API may return out of order)
      const sorted = response.data.sort((a, b) => a.index - b.index);

      return sorted.map(d => new Float32Array(d.embedding));
    },

    dimensions: config.dimensions,
    available: true,
  };
}
