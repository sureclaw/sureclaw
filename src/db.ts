import { randomUUID } from 'node:crypto';
import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';

// ═══════════════════════════════════════════════════════
// Message Queue
// ═══════════════════════════════════════════════════════

export interface QueuedMessage {
  id: string;
  session_id: string;
  channel: string;
  sender: string;
  content: string;
  status: 'pending' | 'processing' | 'done' | 'error';
  created_at: string;
  processed_at: string | null;
}

export class MessageQueue {
  private db: SQLiteDatabase;

  constructor(dbPath: string = dataFile('messages.db')) {
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)
    `);
  }

  enqueue(msg: { sessionId: string; channel: string; sender: string; content: string }): string {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO messages (id, session_id, channel, sender, content, status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(id, msg.sessionId, msg.channel, msg.sender, msg.content);
    return id;
  }

  dequeue(): QueuedMessage | null {
    const row = this.db.prepare(`
      UPDATE messages
      SET status = 'processing', processed_at = datetime('now')
      WHERE id = (
        SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
      )
      RETURNING *
    `).get() as QueuedMessage | undefined;
    return row ?? null;
  }

  complete(id: string): void {
    this.db.prepare(`UPDATE messages SET status = 'done' WHERE id = ?`).run(id);
  }

  fail(id: string): void {
    this.db.prepare(`UPDATE messages SET status = 'error' WHERE id = ?`).run(id);
  }

  pending(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending'`).get() as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }
}
