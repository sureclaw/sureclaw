/**
 * EmbeddingStore — Vector store supporting sqlite-vec and pgvector.
 *
 * When backed by SQLite with sqlite-vec, uses vec0 virtual tables.
 * When backed by PostgreSQL with pgvector, uses vector column type.
 * Falls back gracefully when vector extensions are unavailable.
 */

import { sql, type Kysely } from 'kysely';
import type { DatabaseProvider } from '../../database/types.js';
import { getLogger } from '../../../logger.js';

const logger = getLogger().child({ component: 'embedding-store' });

export interface SimilarityResult {
  itemId: string;
  distance: number;
}

export class EmbeddingStore {
  private db: Kysely<any>;
  private dbType: 'sqlite' | 'postgresql';
  readonly dimensions: number;
  private _ready: Promise<void>;
  private _available = false;

  constructor(database: DatabaseProvider, dimensions: number) {
    this.db = database.db;
    this.dbType = database.type;
    this.dimensions = dimensions;
    this._available = database.vectorsAvailable;
    this._ready = Promise.resolve().then(() => this.init());
  }

  get available(): boolean {
    return this._available;
  }

  private async init(): Promise<void> {
    if (!this._available) return;

    try {
      if (this.dbType === 'sqlite') {
        await this.initSqlite();
      } else {
        await this.initPostgresql();
      }
    } catch (err) {
      logger.warn('embedding_store_init_failed', { error: (err as Error).message });
      this._available = false;
    }
  }

  private async initSqlite(): Promise<void> {
    // Metadata table for scope filtering + embedding BLOB for brute-force queries
    await sql`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        item_id    TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        embedding  BLOB,
        user_id    TEXT
      )
    `.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_emeta_scope ON embedding_meta(scope)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_emeta_user ON embedding_meta(user_id, scope)`.execute(this.db);

    // vec0 virtual table for vector similarity search
    try {
      await sql.raw(
        `CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(embedding float[${this.dimensions}])`,
      ).execute(this.db);
    } catch (err) {
      logger.warn('vec0_unavailable', { error: (err as Error).message });
      this._available = false;
      return;
    }

    // Mapping table: vec0 rowid -> item_id
    await sql`
      CREATE TABLE IF NOT EXISTS embedding_rowmap (
        rowid   INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE
      )
    `.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_rowmap_item ON embedding_rowmap(item_id)`.execute(this.db);
  }

  private async initPostgresql(): Promise<void> {
    // Single table with pgvector column
    await sql.raw(
      `CREATE TABLE IF NOT EXISTS embedding_meta (
        item_id    TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        embedding  vector(${this.dimensions}),
        user_id    TEXT
      )`,
    ).execute(this.db);

    // If the table already existed, the vector column may have stale dimensions
    // (e.g. config changed from 1536 → 1024). Detect and fix so inserts don't fail.
    const dimResult = await sql`
      SELECT a.atttypmod AS dim
      FROM pg_attribute a
      JOIN pg_class c ON a.attrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      WHERE c.relname = 'embedding_meta'
        AND a.attname = 'embedding'
        AND n.nspname = current_schema()
    `.execute(this.db);
    const currentDim = (dimResult.rows as Array<{ dim: number }>)?.[0]?.dim;
    if (currentDim != null && currentDim !== this.dimensions) {
      logger.warn('embedding_dimension_changed', { was: currentDim, now: this.dimensions });
      await sql`ALTER TABLE embedding_meta DROP COLUMN embedding`.execute(this.db);
      await sql.raw(
        `ALTER TABLE embedding_meta ADD COLUMN embedding vector(${this.dimensions})`,
      ).execute(this.db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_emeta_scope ON embedding_meta(scope)`.execute(this.db);
    await sql`CREATE INDEX IF NOT EXISTS idx_emeta_user ON embedding_meta(user_id, scope)`.execute(this.db);
  }

  async ready(): Promise<void> {
    await this._ready;
  }

  async upsert(itemId: string, scope: string, embedding: Float32Array, userId?: string): Promise<void> {
    await this._ready;
    if (!this._available) return;

    if (this.dbType === 'sqlite') {
      await this.upsertSqlite(itemId, scope, embedding, userId);
    } else {
      await this.upsertPostgresql(itemId, scope, embedding, userId);
    }
  }

  private async upsertSqlite(itemId: string, scope: string, embedding: Float32Array, userId?: string): Promise<void> {
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);

    // Check if item already has an embedding
    const existing = await sql<{ rowid: number }>`
      SELECT rowid FROM embedding_rowmap WHERE item_id = ${itemId}
    `.execute(this.db);

    if (existing.rows.length > 0) {
      const rowid = existing.rows[0].rowid;
      await sql`UPDATE item_embeddings SET embedding = ${embeddingBuf} WHERE rowid = ${rowid}`.execute(this.db);
    } else {
      await sql`INSERT INTO item_embeddings(embedding) VALUES (${embeddingBuf})`.execute(this.db);
      const lastRow = await sql<{ rowid: number }>`SELECT last_insert_rowid() as rowid`.execute(this.db);
      const newRowid = lastRow.rows[0]?.rowid;
      if (newRowid != null) {
        await sql`INSERT INTO embedding_rowmap(rowid, item_id) VALUES (${newRowid}, ${itemId})`.execute(this.db);
      }
    }

    // Upsert metadata with embedding BLOB
    await sql`
      INSERT INTO embedding_meta(item_id, scope, created_at, embedding, user_id)
      VALUES (${itemId}, ${scope}, ${new Date().toISOString()}, ${embeddingBuf}, ${userId ?? null})
      ON CONFLICT(item_id) DO UPDATE SET scope = excluded.scope, embedding = excluded.embedding, user_id = excluded.user_id
    `.execute(this.db);
  }

  private async upsertPostgresql(itemId: string, scope: string, embedding: Float32Array, userId?: string): Promise<void> {
    const vectorStr = `[${Array.from(embedding).join(',')}]`;
    await sql`
      INSERT INTO embedding_meta(item_id, scope, embedding, user_id)
      VALUES (${itemId}, ${scope}, ${vectorStr}::vector, ${userId ?? null})
      ON CONFLICT(item_id) DO UPDATE SET
        scope = EXCLUDED.scope,
        embedding = EXCLUDED.embedding,
        user_id = EXCLUDED.user_id
    `.execute(this.db);
  }

  async findSimilar(
    query: Float32Array,
    limit: number,
    scope?: string,
    userId?: string,
  ): Promise<SimilarityResult[]> {
    await this._ready;
    if (!this._available) return [];

    if (this.dbType === 'sqlite') {
      return this.findSimilarSqlite(query, limit, scope, userId);
    }
    return this.findSimilarPostgresql(query, limit, scope, userId);
  }

  private async findSimilarSqlite(
    query: Float32Array,
    limit: number,
    scope?: string,
    userId?: string,
  ): Promise<SimilarityResult[]> {
    if (scope && scope !== '*') {
      const queryBuf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);

      if (userId) {
        const results = await sql<{ item_id: string; distance: number }>`
          SELECT item_id, vec_distance_l2(embedding, ${queryBuf}) as distance
          FROM embedding_meta
          WHERE scope = ${scope} AND (user_id = ${userId} OR user_id IS NULL) AND embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${limit}
        `.execute(this.db);
        return results.rows.map(r => ({ itemId: r.item_id, distance: r.distance }));
      }

      const results = await sql<{ item_id: string; distance: number }>`
        SELECT item_id, vec_distance_l2(embedding, ${queryBuf}) as distance
        FROM embedding_meta
        WHERE scope = ${scope} AND embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${limit}
      `.execute(this.db);
      return results.rows.map(r => ({ itemId: r.item_id, distance: r.distance }));
    }

    // Unscoped: straight vector search via vec0
    const queryBuf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);
    const results = await sql<{ rowid: number; distance: number }>`
      SELECT rowid, distance FROM item_embeddings WHERE embedding MATCH ${queryBuf} ORDER BY distance LIMIT ${limit}
    `.execute(this.db);

    const output: SimilarityResult[] = [];
    for (const row of results.rows) {
      const mapped = await sql<{ item_id: string }>`
        SELECT item_id FROM embedding_rowmap WHERE rowid = ${row.rowid}
      `.execute(this.db);
      if (mapped.rows.length > 0) {
        output.push({ itemId: mapped.rows[0].item_id, distance: row.distance });
      }
    }
    return output;
  }

  private async findSimilarPostgresql(
    query: Float32Array,
    limit: number,
    scope?: string,
    userId?: string,
  ): Promise<SimilarityResult[]> {
    const vectorStr = `[${Array.from(query).join(',')}]`;

    if (scope && scope !== '*') {
      if (userId) {
        const results = await sql<{ item_id: string; distance: number }>`
          SELECT item_id, embedding <-> ${vectorStr}::vector as distance
          FROM embedding_meta
          WHERE scope = ${scope} AND (user_id = ${userId} OR user_id IS NULL) AND embedding IS NOT NULL
          ORDER BY distance ASC
          LIMIT ${limit}
        `.execute(this.db);
        return results.rows.map(r => ({ itemId: r.item_id, distance: r.distance }));
      }

      const results = await sql<{ item_id: string; distance: number }>`
        SELECT item_id, embedding <-> ${vectorStr}::vector as distance
        FROM embedding_meta
        WHERE scope = ${scope} AND embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT ${limit}
      `.execute(this.db);
      return results.rows.map(r => ({ itemId: r.item_id, distance: r.distance }));
    }

    // Unscoped: global vector search
    const results = await sql<{ item_id: string; distance: number }>`
      SELECT item_id, embedding <-> ${vectorStr}::vector as distance
      FROM embedding_meta
      WHERE embedding IS NOT NULL
      ORDER BY distance ASC
      LIMIT ${limit}
    `.execute(this.db);
    return results.rows.map(r => ({ itemId: r.item_id, distance: r.distance }));
  }

  async hasEmbedding(itemId: string): Promise<boolean> {
    await this._ready;
    if (!this._available) return false;
    const result = await sql`SELECT 1 FROM embedding_meta WHERE item_id = ${itemId}`.execute(this.db);
    return result.rows.length > 0;
  }

  async delete(itemId: string): Promise<void> {
    await this._ready;
    if (!this._available) return;

    if (this.dbType === 'sqlite') {
      // Clean up vec0 entries
      const mapped = await sql<{ rowid: number }>`
        SELECT rowid FROM embedding_rowmap WHERE item_id = ${itemId}
      `.execute(this.db);
      if (mapped.rows.length > 0) {
        await sql`DELETE FROM item_embeddings WHERE rowid = ${mapped.rows[0].rowid}`.execute(this.db);
        await sql`DELETE FROM embedding_rowmap WHERE item_id = ${itemId}`.execute(this.db);
      }
    }

    await sql`DELETE FROM embedding_meta WHERE item_id = ${itemId}`.execute(this.db);
  }

  async listUnembedded(allItemIds: string[]): Promise<string[]> {
    await this._ready;
    if (!this._available || allItemIds.length === 0) return [];

    const embedded = new Set<string>();
    const batchSize = 100;
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      // Use Kysely for batch query
      const rows = await this.db.selectFrom('embedding_meta')
        .select('item_id')
        .where('item_id', 'in', batch)
        .execute();
      for (const row of rows) embedded.add(row.item_id as string);
    }

    return allItemIds.filter(id => !embedded.has(id));
  }

  async close(): Promise<void> {
    // No-op: the shared DatabaseProvider owns the connection.
  }
}
