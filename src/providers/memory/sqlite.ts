import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { dataDir, dataFile } from '../../paths.js';
import type { MemoryProvider, MemoryEntry, MemoryQuery } from './types.js';
import type { Config } from '../../types.js';

export async function create(_config: Config): Promise<MemoryProvider> {
  mkdirSync(dataDir(), { recursive: true });
  const db: SQLiteDatabase = openDatabase(dataFile('memory.db'));

  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      taint TEXT,
      agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entries_scope ON entries(scope)
  `);
  // Enterprise: agent-scoped index
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_entries_agent_scope ON entries(agent_id, scope)
  `);
  // Migration: add agent_id column if missing (existing installs)
  try {
    db.exec(`ALTER TABLE entries ADD COLUMN agent_id TEXT`);
  } catch {
    // Column already exists — expected for new installs
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
      entry_id,
      content
    )
  `);

  function serializeTags(tags?: string[]): string | null {
    return tags && tags.length > 0 ? JSON.stringify(tags) : null;
  }

  function deserializeTags(raw: string | null): string[] | undefined {
    return raw ? JSON.parse(raw) : undefined;
  }

  function rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      id: row.id as string,
      scope: row.scope as string,
      content: row.content as string,
      tags: deserializeTags(row.tags as string | null),
      taint: row.taint ? JSON.parse(row.taint as string) : undefined,
      createdAt: new Date(row.created_at as string),
      ...(row.agent_id ? { agentId: row.agent_id as string } : {}),
    };
  }

  return {
    async write(entry: MemoryEntry): Promise<string> {
      const id = entry.id ?? randomUUID();
      // Remove old FTS entry if replacing
      db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(id);
      db.prepare('DELETE FROM entries WHERE id = ?').run(id);
      db.prepare(`
        INSERT INTO entries (id, scope, content, tags, taint, agent_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `).run(
        id,
        entry.scope,
        entry.content,
        serializeTags(entry.tags),
        entry.taint ? JSON.stringify(entry.taint) : null,
        entry.agentId ?? null,
      );
      db.prepare('INSERT INTO entries_fts (entry_id, content) VALUES (?, ?)').run(id, entry.content);
      return id;
    },

    async query(q: MemoryQuery): Promise<MemoryEntry[]> {
      const limit = q.limit ?? 50;
      const agentFilter = q.agentId !== undefined;

      if (q.query) {
        // Use FTS5 for text search, scoped by scope (and optionally agent)
        const sql = agentFilter
          ? `SELECT e.* FROM entries e
             JOIN entries_fts fts ON fts.entry_id = e.id
             WHERE e.scope = ? AND e.agent_id = ? AND entries_fts MATCH ?
             ORDER BY fts.rank LIMIT ?`
          : `SELECT e.* FROM entries e
             JOIN entries_fts fts ON fts.entry_id = e.id
             WHERE e.scope = ? AND entries_fts MATCH ?
             ORDER BY fts.rank LIMIT ?`;
        const params = agentFilter
          ? [q.scope, q.agentId, q.query, limit]
          : [q.scope, q.query, limit];
        const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];

        let results = rows.map(rowToEntry);
        if (q.tags) {
          results = results.filter(e =>
            q.tags!.every(t => e.tags?.includes(t))
          );
        }
        return results;
      }

      // No query text — list by scope (and optionally agent)
      let sql = agentFilter
        ? 'SELECT * FROM entries WHERE scope = ? AND agent_id = ?'
        : 'SELECT * FROM entries WHERE scope = ?';
      const params: unknown[] = agentFilter
        ? [q.scope, q.agentId]
        : [q.scope];

      sql += ' ORDER BY created_at DESC LIMIT ?';
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
      let results = rows.map(rowToEntry);
      if (q.tags) {
        results = results.filter(e =>
          q.tags!.every(t => e.tags?.includes(t))
        );
      }
      return results;
    },

    async read(id: string): Promise<MemoryEntry | null> {
      const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      return row ? rowToEntry(row) : null;
    },

    async delete(id: string): Promise<void> {
      db.prepare('DELETE FROM entries_fts WHERE entry_id = ?').run(id);
      db.prepare('DELETE FROM entries WHERE id = ?').run(id);
    },

    async list(scope: string, limit?: number): Promise<MemoryEntry[]> {
      const rows = db.prepare(
        'SELECT * FROM entries WHERE scope = ? ORDER BY created_at DESC LIMIT ?'
      ).all(scope, limit ?? 50) as Record<string, unknown>[];
      return rows.map(rowToEntry);
    },
  };
}
