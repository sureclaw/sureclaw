import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';

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

  constructor(dbPath: string = dataFile('conversations.db')) {
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender TEXT,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id)
    `);
  }

  /** Append a turn to the session. */
  append(sessionId: string, role: 'user' | 'assistant', content: string, sender?: string): void {
    this.db.prepare(
      'INSERT INTO turns (session_id, role, sender, content) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, sender ?? null, content);
  }

  /** Load the last `maxTurns` turns for a session (oldest first). */
  load(sessionId: string, maxTurns?: number): StoredTurn[] {
    if (maxTurns !== undefined && maxTurns > 0) {
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

  /** Clear all turns for a session. */
  clear(sessionId: string): void {
    this.db.prepare('DELETE FROM turns WHERE session_id = ?').run(sessionId);
  }

  close(): void {
    this.db.close();
  }
}
