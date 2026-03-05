// src/providers/database/postgres.ts — PostgreSQL DatabaseProvider using pg + pgvector
import type { Config } from '../../types.js';
import type { DatabaseProvider } from './types.js';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createRequire } from 'node:module';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'database/postgres' });

export async function create(_config: Config): Promise<DatabaseProvider> {
  const connectionString = process.env.POSTGRESQL_URL
    ?? process.env.DATABASE_URL
    ?? 'postgresql://localhost:5432/ax';

  const req = createRequire(import.meta.url);
  const { Pool } = req('pg');
  const pool = new Pool({ connectionString });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

  // Try enabling pgvector extension
  let vectorsAvailable = false;
  try {
    await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(db);
    vectorsAvailable = true;
  } catch {
    logger.debug('pgvector_unavailable', { msg: 'pgvector not available — vector search disabled' });
  }

  return {
    db,
    type: 'postgresql',
    vectorsAvailable,
    async close() {
      await db.destroy();
    },
  };
}
