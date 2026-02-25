import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { conversationsMigrations } from './migrations/conversations.js';
import type { ContentBlock } from './types.js';

export interface StoredTurn {
  id: number;
  session_id: string;
  role: 'user' | 'assistant';
  sender: string | null;
  /** Plain text or JSON-serialized ContentBlock[]. */
  content: string;
  created_at: number;
}

/**
 * Serialize message content for storage.
 * Strings are stored as-is. ContentBlock arrays are JSON-stringified.
 */
export function serializeContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  // Defense-in-depth: strip image_data blocks (transient, large base64) before
  // persisting. These should already be converted to image file-ref blocks
  // upstream, but guard against accidental leakage.
  const safe = content.filter(b => b.type !== 'image_data');
  return JSON.stringify(safe);
}

/**
 * Deserialize stored content back to string or ContentBlock[].
 * Detects JSON arrays by checking if the string starts with '['.
 */
export function deserializeContent(raw: string): string | ContentBlock[] {
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.type === 'string') {
        return parsed as ContentBlock[];
      }
    } catch {
      // Not valid JSON — return as plain string
    }
  }
  return raw;
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

  /** Append a turn to the session. Accepts plain text or ContentBlock[]. */
  append(sessionId: string, role: 'user' | 'assistant', content: string | ContentBlock[], sender?: string): void {
    const serialized = serializeContent(content);
    this.db.prepare(
      'INSERT INTO turns (session_id, role, sender, content) VALUES (?, ?, ?, ?)'
    ).run(sessionId, role, sender ?? null, serialized);
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
