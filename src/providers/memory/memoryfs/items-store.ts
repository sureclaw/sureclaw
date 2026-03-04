// src/providers/memory/memoryfs/items-store.ts — SQLite CRUD for MemoryFS items
import { randomUUID } from 'node:crypto';
import { openDatabase, type SQLiteDatabase } from '../../../utils/sqlite.js';
import type { MemoryFSItem } from './types.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS items (
    id                  TEXT PRIMARY KEY,
    content             TEXT NOT NULL,
    memory_type         TEXT NOT NULL,
    category            TEXT NOT NULL,
    content_hash        TEXT NOT NULL,
    source              TEXT,
    confidence          REAL DEFAULT 0.5,
    reinforcement_count INTEGER DEFAULT 1,
    last_reinforced_at  TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    scope               TEXT NOT NULL DEFAULT 'default',
    agent_id            TEXT,
    user_id             TEXT,
    taint               TEXT,
    extra               TEXT
  )
`;

const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_items_scope ON items(scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_category ON items(category, scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_hash ON items(content_hash, scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_agent ON items(agent_id, scope)',
  'CREATE INDEX IF NOT EXISTS idx_items_user ON items(user_id, scope)',
];

export class ItemsStore {
  private db: SQLiteDatabase;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.db.exec(CREATE_TABLE);
    for (const idx of CREATE_INDEXES) {
      this.db.exec(idx);
    }
  }

  insert(item: Omit<MemoryFSItem, 'id'>): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO items (id, content, memory_type, category, content_hash, source,
        confidence, reinforcement_count, last_reinforced_at, created_at, updated_at,
        scope, agent_id, user_id, taint, extra)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, item.content, item.memoryType, item.category, item.contentHash,
      item.source ?? null, item.confidence, item.reinforcementCount,
      item.lastReinforcedAt, item.createdAt, item.updatedAt,
      item.scope, item.agentId ?? null, item.userId ?? null,
      item.taint ?? null, item.extra ?? null,
    );
    return id;
  }

  getById(id: string): MemoryFSItem | null {
    const row = this.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToItem(row) : null;
  }

  findByHash(contentHash: string, scope: string, agentId?: string, userId?: string): MemoryFSItem | null {
    let sql = 'SELECT * FROM items WHERE content_hash = ? AND scope = ?';
    const params: unknown[] = [contentHash, scope];
    // Agent scoping: match specific agent or NULL
    sql += agentId ? ' AND agent_id = ?' : ' AND agent_id IS NULL';
    if (agentId) params.push(agentId);
    // User scoping: match specific user or NULL
    sql += userId ? ' AND user_id = ?' : ' AND user_id IS NULL';
    if (userId) params.push(userId);
    const row = this.db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    return row ? this.rowToItem(row) : null;
  }

  reinforce(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE items SET reinforcement_count = reinforcement_count + 1,
        last_reinforced_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);
  }

  listByCategory(category: string, scope: string, limit?: number, userId?: string): MemoryFSItem[] {
    let sql = 'SELECT * FROM items WHERE category = ? AND scope = ?';
    const params: unknown[] = [category, scope];
    if (userId) {
      sql += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }
    sql += ' ORDER BY created_at DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  listByScope(scope: string, limit?: number, agentId?: string, userId?: string): MemoryFSItem[] {
    let sql = 'SELECT * FROM items WHERE scope = ?';
    const params: unknown[] = [scope];
    if (agentId) {
      sql += ' AND agent_id = ?';
      params.push(agentId);
    }
    // User scoping: when userId set, return user's own + shared (user_id IS NULL)
    if (userId) {
      sql += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(userId);
    }
    sql += ' ORDER BY created_at DESC';
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  getAllForCategory(category: string, scope: string): MemoryFSItem[] {
    const rows = this.db.prepare(
      'SELECT * FROM items WHERE category = ? AND scope = ? ORDER BY created_at ASC',
    ).all(category, scope) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  searchContent(query: string, scope: string, limit = 50, userId?: string): MemoryFSItem[] {
    if (userId) {
      const rows = this.db.prepare(
        'SELECT * FROM items WHERE scope = ? AND content LIKE ? AND (user_id = ? OR user_id IS NULL) ORDER BY created_at DESC LIMIT ?',
      ).all(scope, `%${query}%`, userId, limit) as Record<string, unknown>[];
      return rows.map(r => this.rowToItem(r));
    }
    const rows = this.db.prepare(
      'SELECT * FROM items WHERE scope = ? AND content LIKE ? ORDER BY created_at DESC LIMIT ?',
    ).all(scope, `%${query}%`, limit) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  getByIds(ids: string[]): MemoryFSItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM items WHERE id IN (${placeholders})`,
    ).all(...ids) as Record<string, unknown>[];
    return rows.map(r => this.rowToItem(r));
  }

  /** Return all item IDs in a given scope. Used for backfill checks. */
  listIdsByScope(scope: string): string[] {
    const rows = this.db.prepare(
      'SELECT id FROM items WHERE scope = ?',
    ).all(scope) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  /** Return all distinct scopes that have items. */
  listAllScopes(): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT scope FROM items',
    ).all() as Array<{ scope: string }>;
    return rows.map(r => r.scope);
  }

  deleteById(id: string): void {
    this.db.prepare('DELETE FROM items WHERE id = ?').run(id);
  }

  close(): void {
    this.db.close();
  }

  private rowToItem(row: Record<string, unknown>): MemoryFSItem {
    return {
      id: row.id as string,
      content: row.content as string,
      memoryType: row.memory_type as MemoryFSItem['memoryType'],
      category: row.category as string,
      contentHash: row.content_hash as string,
      source: (row.source as string) || undefined,
      confidence: row.confidence as number,
      reinforcementCount: row.reinforcement_count as number,
      lastReinforcedAt: row.last_reinforced_at as string,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      scope: row.scope as string,
      agentId: (row.agent_id as string) || undefined,
      userId: (row.user_id as string) || undefined,
      taint: (row.taint as string) || undefined,
      extra: (row.extra as string) || undefined,
    };
  }
}
