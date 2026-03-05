// src/providers/database/types.ts — Shared database connection factory interface
import type { Kysely } from 'kysely';

/**
 * DatabaseProvider — a shared connection factory that storage, audit, memory,
 * and other providers consume instead of each managing their own database.
 *
 * The host creates exactly one DatabaseProvider per process. Consumers run
 * their own migrations against the shared Kysely instance.
 */
export interface DatabaseProvider {
  /** The shared Kysely instance for all queries. */
  readonly db: Kysely<any>;
  /** Database dialect — consumers use this for dialect-specific SQL. */
  readonly type: 'sqlite' | 'postgresql';
  /** Whether the vector extension (sqlite-vec or pgvector) loaded successfully. */
  readonly vectorsAvailable: boolean;
  /** Close the database connection. */
  close(): Promise<void>;
}
