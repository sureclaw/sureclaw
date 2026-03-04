/**
 * EmbeddingStore — Vector store backed by sqlite-vec's vec0 virtual table.
 *
 * Uses better-sqlite3 + sqlite-vec to load the sqlite-vec extension.
 * Stores embedding vectors alongside item IDs and supports
 * nearest-neighbor similarity search.
 *
 * Separate from ItemsStore — operates on its own database file (_vec.db)
 * to avoid extension compatibility issues with the existing SQLite adapter.
 */

import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { getLogger } from '../../../logger.js';

const logger = getLogger().child({ component: 'embedding-store' });

export interface SimilarityResult {
  itemId: string;
  distance: number;
}

export class EmbeddingStore {
  private db: BetterSqlite3.Database | null = null;
  private readonly dbPath: string;
  readonly dimensions: number;
  private _ready: Promise<void>;
  /** True when sqlite-vec loaded successfully and vec0 tables are available. */
  private _available = false;

  constructor(dbPath: string, dimensions: number) {
    this.dbPath = dbPath;
    this.dimensions = dimensions;
    this._ready = Promise.resolve().then(() => this.init());
  }

  /** Whether the vec0 extension loaded and the store is operational. */
  get available(): boolean {
    return this._available;
  }

  private init(): void {
    let db: BetterSqlite3.Database;
    try {
      const created = new Database(this.dbPath);
      created.pragma('journal_mode = WAL');
      sqliteVec.load(created);
      db = created;
    } catch (err) {
      logger.warn('sqlite_vec_load_failed', { error: (err as Error).message });
      return; // Degrade gracefully — vector search will be unavailable
    }
    this.db = db;

    // Metadata table for scope filtering + tracking which items have embeddings.
    // The embedding BLOB column stores a copy of the vector for scoped brute-force
    // queries via vec_distance_l2(), since vec0 MATCH doesn't support WHERE filtering.
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        item_id    TEXT PRIMARY KEY,
        scope      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        embedding  BLOB
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_emeta_scope ON embedding_meta(scope)');

    // Migration: add embedding column if upgrading from older schema
    try {
      db.exec('ALTER TABLE embedding_meta ADD COLUMN embedding BLOB');
    } catch {
      // Column already exists — expected on non-first run
    }

    // Migration: add user_id column for multi-user memory scoping
    try {
      db.exec('ALTER TABLE embedding_meta ADD COLUMN user_id TEXT');
    } catch {
      // Column already exists — expected on non-first run
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_emeta_user ON embedding_meta(user_id, scope)');

    // vec0 virtual table for vector similarity search
    try {
      db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS item_embeddings USING vec0(embedding float[${this.dimensions}])`,
      );
    } catch (err) {
      logger.warn('vec0_unavailable', { error: (err as Error).message });
      return; // Degrade gracefully — keyword search still works
    }

    // Mapping table: vec0 rowid -> item_id (vec0 uses integer rowids internally)
    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_rowmap (
        rowid   INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL UNIQUE
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_rowmap_item ON embedding_rowmap(item_id)');

    this._available = true;
    logger.debug('init', { dbPath: this.dbPath, dimensions: this.dimensions });
  }

  /** Wait for initialization to complete. */
  async ready(): Promise<void> {
    await this._ready;
  }

  /** Insert or update an embedding for the given item. */
  async upsert(itemId: string, scope: string, embedding: Float32Array, userId?: string): Promise<void> {
    await this._ready;
    if (!this._available) return;
    const db = this.db!;

    // Check if item already has an embedding
    const existingStmt = db.prepare(
      'SELECT rowid FROM embedding_rowmap WHERE item_id = ?',
    );
    const existing = existingStmt.get(itemId) as { rowid: number } | undefined;

    if (existing) {
      // Update existing embedding
      const updateStmt = db.prepare(
        'UPDATE item_embeddings SET embedding = ? WHERE rowid = ?',
      );
      updateStmt.run(embedding, existing.rowid);
    } else {
      // Insert new embedding — vec0 auto-assigns rowid
      const insertVecStmt = db.prepare(
        'INSERT INTO item_embeddings(embedding) VALUES (?)',
      );
      const result = insertVecStmt.run(embedding);

      // Map rowid -> item_id
      const mapStmt = db.prepare(
        'INSERT INTO embedding_rowmap(rowid, item_id) VALUES (?, ?)',
      );
      mapStmt.run(result.lastInsertRowid, itemId);
    }

    // Upsert metadata (includes embedding BLOB for scoped brute-force queries)
    const embeddingBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const metaStmt = db.prepare(
      `INSERT INTO embedding_meta(item_id, scope, created_at, embedding, user_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET scope = excluded.scope, embedding = excluded.embedding, user_id = excluded.user_id`,
    );
    metaStmt.run(itemId, scope, new Date().toISOString(), embeddingBuf, userId ?? null);
  }

  /**
   * Find items most similar to the query vector.
   * Returns results ordered by ascending distance (closest first).
   *
   * When userId is set, returns items belonging to that user + shared (user_id IS NULL).
   * When userId is absent, returns only shared items (user_id IS NULL).
   */
  async findSimilar(
    query: Float32Array,
    limit: number,
    scope?: string,
    userId?: string,
  ): Promise<SimilarityResult[]> {
    await this._ready;
    if (!this._available) return [];
    const db = this.db!;

    if (scope && scope !== '*') {
      // Scoped query: brute-force exact distances using vec_distance_l2() on
      // the embedding_meta table, filtered by scope. This avoids the incorrect
      // global-MATCH-then-filter approach that could miss in-scope neighbors.
      const queryBuf = Buffer.from(query.buffer, query.byteOffset, query.byteLength);

      if (userId) {
        // User-scoped: return user's own + shared (user_id IS NULL)
        const stmt = db.prepare(
          `SELECT item_id, vec_distance_l2(embedding, ?) as distance
           FROM embedding_meta
           WHERE scope = ? AND (user_id = ? OR user_id IS NULL) AND embedding IS NOT NULL
           ORDER BY distance ASC
           LIMIT ?`,
        );
        const results = stmt.all(queryBuf, scope, userId, limit) as Array<{ item_id: string; distance: number }>;
        return results.map(r => ({ itemId: r.item_id, distance: r.distance }));
      }

      const scopeStmt = db.prepare(
        `SELECT item_id, vec_distance_l2(embedding, ?) as distance
         FROM embedding_meta
         WHERE scope = ? AND embedding IS NOT NULL
         ORDER BY distance ASC
         LIMIT ?`,
      );
      const results = scopeStmt.all(queryBuf, scope, limit) as Array<{ item_id: string; distance: number }>;

      return results.map(r => ({ itemId: r.item_id, distance: r.distance }));
    }

    // Unscoped: straight vector search
    const searchStmt = db.prepare(
      `SELECT rowid, distance FROM item_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    );
    const results = searchStmt.all(query, limit) as Array<{ rowid: number; distance: number }>;

    const output: SimilarityResult[] = [];
    const mapStmt = db.prepare('SELECT item_id FROM embedding_rowmap WHERE rowid = ?');
    for (const row of results) {
      const mapped = mapStmt.get(row.rowid) as { item_id: string } | undefined;
      if (mapped) {
        output.push({ itemId: mapped.item_id, distance: row.distance });
      }
    }
    return output;
  }

  /** Check if an item has an embedding stored. */
  async hasEmbedding(itemId: string): Promise<boolean> {
    await this._ready;
    if (!this._available) return false;
    const stmt = this.db!.prepare('SELECT 1 FROM embedding_meta WHERE item_id = ?');
    return stmt.get(itemId) !== undefined;
  }

  /** Delete embedding for a given item. */
  async delete(itemId: string): Promise<void> {
    await this._ready;
    if (!this._available) return;
    const db = this.db!;

    // Find the rowid for this item
    const mapStmt = db.prepare('SELECT rowid FROM embedding_rowmap WHERE item_id = ?');
    const mapped = mapStmt.get(itemId) as { rowid: number } | undefined;

    if (mapped) {
      const delVecStmt = db.prepare('DELETE FROM item_embeddings WHERE rowid = ?');
      delVecStmt.run(mapped.rowid);
      const delMapStmt = db.prepare('DELETE FROM embedding_rowmap WHERE item_id = ?');
      delMapStmt.run(itemId);
    }

    const delMetaStmt = db.prepare('DELETE FROM embedding_meta WHERE item_id = ?');
    delMetaStmt.run(itemId);
  }

  /**
   * List item IDs that exist in a given set but have no embedding yet.
   * Used for backfill.
   */
  async listUnembedded(allItemIds: string[]): Promise<string[]> {
    await this._ready;
    if (!this._available || allItemIds.length === 0) return [];

    const embedded = new Set<string>();
    // Batch check in groups to avoid huge SQL queries
    const batchSize = 100;
    for (let i = 0; i < allItemIds.length; i += batchSize) {
      const batch = allItemIds.slice(i, i + batchSize);
      const placeholders = batch.map(() => '?').join(',');
      const stmt = this.db!.prepare(
        `SELECT item_id FROM embedding_meta WHERE item_id IN (${placeholders})`,
      );
      const rows = stmt.all(...batch) as Array<{ item_id: string }>;
      for (const row of rows) embedded.add(row.item_id);
    }

    return allItemIds.filter(id => !embedded.has(id));
  }

  /** Close the database connection. */
  async close(): Promise<void> {
    await this._ready;
    if (this._available && this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
