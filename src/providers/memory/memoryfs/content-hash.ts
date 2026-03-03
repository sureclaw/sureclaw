import { createHash } from 'node:crypto';
import type { RefId } from './types.js';

/**
 * Compute deterministic content hash for deduplication.
 * Hash is based solely on normalized content text (type-agnostic) so the same
 * fact deduplicates even when the LLM assigns different memory types.
 */
export function computeContentHash(content: string): string {
  const normalized = content.toLowerCase().split(/\s+/).join(' ').trim();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Build short ref ID for [ref:ID] citations in category summaries.
 * Uses first 6 hex chars of content hash.
 */
export function buildRefId(contentHash: string): RefId {
  return contentHash.slice(0, 6);
}
