// src/utils/database.ts — Kysely instance factory for SQLite / PostgreSQL
import { Kysely, SqliteDialect } from 'kysely';
import { createRequire } from 'node:module';

export interface SqliteDbConfig {
  type: 'sqlite';
  path: string;
}

export interface PostgresDbConfig {
  type: 'postgresql';
  url: string;
}

export type DbConfig = SqliteDbConfig | PostgresDbConfig;

/**
 * Create a Kysely instance for the given database configuration.
 *
 * - SQLite: uses better-sqlite3 (same dep already in package.json).
 * - PostgreSQL: uses pg Pool (must be installed separately).
 */
export function createKyselyDb(config: DbConfig): Kysely<any> {
  if (config.type === 'sqlite') {
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3');
    const sqliteDb = new Database(config.path);
    sqliteDb.pragma('journal_mode = WAL');
    sqliteDb.pragma('foreign_keys = ON');
    return new Kysely({ dialect: new SqliteDialect({ database: sqliteDb }) });
  }

  if (config.type === 'postgresql') {
    // Lazy-load pg to avoid requiring it when using SQLite
    const req = createRequire(import.meta.url);
    const { Pool } = req('pg');
    const { PostgresDialect } = req('kysely');
    return new Kysely({
      dialect: new PostgresDialect({ pool: new Pool({ connectionString: config.url }) }),
    });
  }

  throw new Error(`Unsupported database type: ${(config as any).type}`);
}
