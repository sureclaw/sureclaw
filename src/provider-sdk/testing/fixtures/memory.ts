/**
 * Test fixtures for memory provider contract tests.
 *
 * Provider authors can use these fixtures to test their memory
 * implementations against known-good input/output pairs.
 */

import type { MemoryEntry, MemoryQuery } from '../../interfaces/index.js';

export const MEMORY_FIXTURES = {
  /** Minimal valid entry. */
  minimalEntry: {
    scope: 'test',
    content: 'hello world',
  } satisfies Omit<MemoryEntry, 'id'>,

  /** Entry with all optional fields. */
  fullEntry: {
    scope: 'facts/user',
    content: 'User prefers dark mode',
    tags: ['preference', 'ui'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  } satisfies Omit<MemoryEntry, 'id'>,

  /** Entry with taint tag (external content). */
  taintedEntry: {
    scope: 'external',
    content: 'Data from web search',
    taint: {
      source: 'web',
      trust: 'external' as const,
      timestamp: new Date('2026-01-01T00:00:00Z'),
    },
  } satisfies Omit<MemoryEntry, 'id'>,

  /** Query with no filters (returns all in scope). */
  broadQuery: {
    scope: 'test',
  } satisfies MemoryQuery,

  /** Query with text search. */
  textQuery: {
    scope: 'test',
    query: 'dark mode',
    limit: 10,
  } satisfies MemoryQuery,

  /** Query with tag filter. */
  tagQuery: {
    scope: 'facts/user',
    tags: ['preference'],
    limit: 5,
  } satisfies MemoryQuery,
} as const;
