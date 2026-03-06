// src/migrations/dialect.ts — Shared SQL dialect helpers for migrations
import { sql, type RawBuilder } from 'kysely';

export type DbDialect = 'sqlite' | 'postgresql';

/** SQL expression for current datetime as text (SQLite) or timestamptz (PostgreSQL). */
export function sqlNow(dbType: DbDialect): RawBuilder<unknown> {
  return dbType === 'postgresql' ? sql`NOW()` : sql`(datetime('now'))`;
}

/** SQL expression for current time as integer epoch seconds. */
export function sqlEpoch(dbType: DbDialect): RawBuilder<unknown> {
  return dbType === 'postgresql'
    ? sql`(EXTRACT(EPOCH FROM NOW())::integer)`
    : sql`(unixepoch())`;
}
