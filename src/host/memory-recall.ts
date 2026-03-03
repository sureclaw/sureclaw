/**
 * Memory recall — queries long-term memory using the current user message
 * and formats matching entries as context turns to prepend to conversation
 * history. This gives the agent relevant cross-session knowledge without
 * relying on it to proactively call the memory tool.
 *
 * Supports two recall strategies:
 *   1. Embedding-based semantic search (preferred — when EmbeddingClient is available)
 *   2. Keyword extraction fallback (when no OPENAI_API_KEY / embedding client)
 *
 * Runs on the host side (trusted process) with direct memory provider access.
 */

import type { MemoryProvider, MemoryEntry } from '../providers/memory/types.js';
import type { EmbeddingClient } from '../utils/embedding-client.js';
import type { Logger } from '../logger.js';

export interface MemoryRecallConfig {
  /** Enable automatic memory recall injection (default: false). */
  enabled: boolean;
  /** Maximum number of memory entries to inject (default: 5). */
  limit: number;
  /** Memory scope to search (default: '*' = all scopes). */
  scope: string;
  /** Embedding client for semantic search (optional — falls back to keywords). */
  embeddingClient?: EmbeddingClient;
}

export const MEMORY_RECALL_DEFAULTS: MemoryRecallConfig = {
  enabled: false,
  limit: 5,
  scope: '*',
};

/**
 * Extract keywords from user message for keyword-based query.
 *
 * Extracts meaningful words (skip short ones and stop words) and
 * joins them with OR for broad matching.
 */
export function extractQueryTerms(message: string): string {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'must', 'to', 'of', 'in',
    'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
    'we', 'our', 'you', 'your', 'he', 'she', 'they', 'them', 'what',
    'which', 'who', 'when', 'where', 'how', 'not', 'no', 'but', 'or',
    'and', 'if', 'then', 'so', 'just', 'also', 'very', 'too', 'please',
  ]);

  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stopWords.has(w));

  // Deduplicate
  const unique = [...new Set(words)];

  // Take at most 10 terms to keep the query reasonable
  return unique.slice(0, 10).join(' OR ');
}

/**
 * Format memory entries as conversation context turns.
 * Returns a user/assistant turn pair that the agent sees as the oldest
 * part of the conversation.
 */
function formatMemoryTurns(
  entries: MemoryEntry[],
): { role: 'user' | 'assistant'; content: string }[] {
  if (entries.length === 0) return [];

  const lines = entries.map((e, i) => {
    const tags = e.tags?.length ? ` [${e.tags.join(', ')}]` : '';
    const date = e.createdAt
      ? ` (${new Date(e.createdAt).toISOString().split('T')[0]})`
      : '';
    return `${i + 1}. ${e.content}${tags}${date}`;
  });

  const recallContent =
    `[Long-term memory recall — ${entries.length} relevant memories from past sessions]\n\n` +
    lines.join('\n');

  return [
    { role: 'user' as const, content: recallContent },
    { role: 'assistant' as const, content: 'I\'ll keep this prior context in mind as we continue.' },
  ];
}

/**
 * Query long-term memory for entries relevant to the user's message
 * and return formatted context turns to prepend to conversation history.
 *
 * Strategy:
 *   1. If embeddingClient is available → embed user message, use vector search
 *   2. Otherwise → extract keywords, use keyword search
 *
 * Returns empty array if disabled, no matches, or on error.
 */
export async function recallMemoryForMessage(
  userMessage: string,
  memory: MemoryProvider,
  config: MemoryRecallConfig,
  logger: Logger,
): Promise<{ role: 'user' | 'assistant'; content: string }[]> {
  if (!config.enabled) return [];

  // Strategy 1: Embedding-based semantic search
  if (config.embeddingClient?.available) {
    try {
      const [embedding] = await config.embeddingClient.embed([userMessage]);

      const entries = await memory.query({
        scope: config.scope,
        embedding,
        limit: config.limit,
      });

      if (entries.length > 0) {
        logger.info('memory_recall_hit', {
          strategy: 'embedding',
          matchCount: entries.length,
          entryIds: entries.map(e => e.id).filter(Boolean),
        });
        return formatMemoryTurns(entries);
      }

      logger.debug('memory_recall_empty', { strategy: 'embedding' });
      return [];
    } catch (err) {
      // Embedding failed — fall through to keyword search
      logger.warn('memory_recall_embedding_failed', {
        error: (err as Error).message,
        fallback: 'keyword',
      });
    }
  }

  // Strategy 2: Keyword extraction fallback
  const queryTerms = extractQueryTerms(userMessage);
  if (!queryTerms) {
    logger.debug('memory_recall_skip', { reason: 'no_query_terms', strategy: 'keyword' });
    return [];
  }

  try {
    const entries = await memory.query({
      scope: config.scope,
      query: queryTerms,
      limit: config.limit,
    });

    if (entries.length === 0) {
      logger.debug('memory_recall_empty', { strategy: 'keyword', queryTerms });
      return [];
    }

    logger.info('memory_recall_hit', {
      strategy: 'keyword',
      queryTerms,
      matchCount: entries.length,
      entryIds: entries.map(e => e.id).filter(Boolean),
    });

    return formatMemoryTurns(entries);
  } catch (err) {
    logger.warn('memory_recall_failed', { error: (err as Error).message });
    return [];
  }
}
