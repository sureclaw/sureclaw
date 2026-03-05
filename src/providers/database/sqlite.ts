// src/providers/database/sqlite.ts — SQLite DatabaseProvider using better-sqlite3 + sqlite-vec
import type { Config } from '../../types.js';
import type { DatabaseProvider } from './types.js';
import { dataDir, dataFile } from '../../paths.js';
import { mkdirSync } from 'node:fs';
import { Kysely, SqliteDialect } from 'kysely';
import { createRequire } from 'node:module';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'database/sqlite' });

export async function create(_config: Config): Promise<DatabaseProvider> {
  mkdirSync(dataDir(), { recursive: true });
  const dbPath = dataFile('ax.db');

  const req = createRequire(import.meta.url);
  const Database = req('better-sqlite3');
  const sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL');
  sqliteDb.pragma('foreign_keys = ON');

  // Try loading sqlite-vec extension
  let vectorsAvailable = false;
  try {
    const sqliteVec = req('sqlite-vec');
    sqliteVec.load(sqliteDb);
    vectorsAvailable = true;
  } catch {
    logger.debug('sqlite_vec_unavailable', { msg: 'sqlite-vec not available — vector search disabled' });
  }

  const db = new Kysely({ dialect: new SqliteDialect({ database: sqliteDb }) });

  return {
    db,
    type: 'sqlite',
    vectorsAvailable,
    async close() {
      await db.destroy();
    },
  };
}
