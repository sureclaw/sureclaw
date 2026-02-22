import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { conversationsMigrations } from './migrations/conversations.js';

export interface StoredTurn {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  sender: string | null;
  content: string;
  created_at: number;
}

export class ConversationStore {
  private db: SQLiteDatabase;

  private constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  static async create(dbPath: string = dataFile('conversations.db')): Promise<ConversationStore> {
    const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
    try {
      const result = await runMigrations(kyselyDb, conversationsMigrations);
      if (result.error) throw result.error;
    } finally {
      await kyselyDb.destroy();
    }
    const db = openDatabase(dbPath);
    return new ConversationStore(db);
  }

  /** Append a turn to the session. */
  append(sessionId: string, role: 'user' | 'assistant', content: string, sender?: string): void {
    this.db.prepare(
      'INSERT INTO turns (session_id, role, sender, content) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, sender ?? null, content);
  }

  /** Load the last `maxTurns` turns for a session (oldest first). */
  load(sessionId: string, maxTurns?: number): StoredTurn[] {
    if (maxTurns !== undefined) {
      if (maxTurns <= 0) return [];
      return this.db.prepare(`
        SELECT * FROM (
          SELECT id, session_id, role, sender, content, created_at
          FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?
        ) ORDER BY id ASC
      `).all(sessionId, maxTurns) as StoredTurn[];
    }
    return this.db.prepare(
      'SELECT id, session_id, role, sender, content, created_at FROM turns WHERE session_id = ? ORDER BY id ASC'
    ).all(sessionId) as StoredTurn[];
  }

  /** Delete turns older than the last `keep` for a session. */
  prune(sessionId: string, keep: number): void {
    this.db.prepare(`
      DELETE FROM turns WHERE session_id = ? AND id NOT IN (
        SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT ?
      )
    `).run(sessionId, sessionId, keep);
  }

  /** Count the number of turns for a session. */
  count(sessionId: string): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM turns WHERE session_id = ?'
    ).get(sessionId) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  /** Clear all turns for a session. */
  clear(sessionId: string): void {
    this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
