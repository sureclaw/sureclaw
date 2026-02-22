import { randomUUID } from 'node:crypto';
import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';
import { createKyselyDb } from './utils/database.js';
import { runMigrations } from './utils/migrator.js';
import { messagesMigrations } from './migrations/messages.js';

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

  private constructor(db: SQLiteDatabase) {
    this.db = db;
  }

  static async create(dbPath: string = dataFile('messages.db')): Promise<MessageQueue> {
    const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
    try {
      const result = await runMigrations(kyselyDb, messagesMigrations);
      if (result.error) throw result.error;
    } finally {
      await kyselyDb.destroy();
    }
    const db = openDatabase(dbPath);
    return new MessageQueue(db);
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

  dequeueById(id: string): QueuedMessage | null {
    const row = this.db.prepare(`
      UPDATE messages
      SET status = 'processing', processed_at = datetime('now')
      WHERE id = ? AND status = 'pending'
      RETURNING *
    `).get(id) as QueuedMessage | undefined;
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
