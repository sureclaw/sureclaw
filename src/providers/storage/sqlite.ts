// src/providers/storage/sqlite.ts — SQLite StorageProvider implementation
//
// Wraps the existing MessageQueue, ConversationStore, and SessionStore
// classes behind async interfaces, plus a documents table for key-value storage.

import { mkdirSync } from 'node:fs';
import { openDatabase } from '../../utils/sqlite.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';
import { dataDir, dataFile } from '../../paths.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { documentsMigrations } from '../../migrations/documents.js';
import { MessageQueue } from '../../db.js';
import { ConversationStore } from '../../conversation-store.js';
import { SessionStore } from '../../session-store.js';
import type { Config } from '../../types.js';
import type {
  StorageProvider,
  MessageQueueStore,
  ConversationStoreProvider,
  SessionStoreProvider,
  DocumentStore,
} from './types.js';

/**
 * Wrap the synchronous MessageQueue class behind the async MessageQueueStore interface.
 */
function wrapMessageQueue(mq: MessageQueue): MessageQueueStore {
  return {
    async enqueue(msg) { return mq.enqueue(msg); },
    async dequeue() { return mq.dequeue(); },
    async dequeueById(id) { return mq.dequeueById(id); },
    async complete(id) { mq.complete(id); },
    async fail(id) { mq.fail(id); },
    async pending() { return mq.pending(); },
  };
}

/**
 * Wrap the synchronous ConversationStore class behind the async interface.
 */
function wrapConversationStore(cs: ConversationStore): ConversationStoreProvider {
  return {
    async append(sessionId, role, content, sender?) { cs.append(sessionId, role, content, sender); },
    async load(sessionId, maxTurns?) { return cs.load(sessionId, maxTurns); },
    async prune(sessionId, keep) { cs.prune(sessionId, keep); },
    async count(sessionId) { return cs.count(sessionId); },
    async clear(sessionId) { cs.clear(sessionId); },
    async loadOlderTurns(sessionId, keepRecent) { return cs.loadOlderTurns(sessionId, keepRecent); },
    async replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent) {
      cs.replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent);
    },
  };
}

/**
 * Wrap the synchronous SessionStore class behind the async interface.
 */
function wrapSessionStore(ss: SessionStore): SessionStoreProvider {
  return {
    async trackSession(agentId, session) { ss.trackSession(agentId, session); },
    async getLastChannelSession(agentId) { return ss.getLastChannelSession(agentId); },
  };
}

/**
 * Create a DocumentStore backed by a SQLite database.
 */
async function createDocumentStore(dbPath: string): Promise<{ store: DocumentStore; close: () => void }> {
  // Run migrations via Kysely (following existing pattern)
  const kyselyDb = createKyselyDb({ type: 'sqlite', path: dbPath });
  try {
    const result = await runMigrations(kyselyDb, documentsMigrations);
    if (result.error) throw result.error;
  } finally {
    await kyselyDb.destroy();
  }

  // Open a direct SQLite connection for runtime operations
  const db: SQLiteDatabase = openDatabase(dbPath);

  const store: DocumentStore = {
    async get(collection: string, key: string): Promise<string | undefined> {
      const row = db.prepare(
        'SELECT content FROM documents WHERE collection = ? AND key = ?'
      ).get(collection, key) as { content: string } | undefined;
      return row?.content;
    },

    async put(collection: string, key: string, content: string): Promise<void> {
      db.prepare(
        `INSERT OR REPLACE INTO documents (collection, key, content, updated_at)
         VALUES (?, ?, ?, datetime('now'))`
      ).run(collection, key, content);
    },

    async delete(collection: string, key: string): Promise<boolean> {
      const exists = db.prepare(
        'SELECT 1 FROM documents WHERE collection = ? AND key = ?'
      ).get(collection, key);
      if (!exists) return false;
      db.prepare(
        'DELETE FROM documents WHERE collection = ? AND key = ?'
      ).run(collection, key);
      return true;
    },

    async list(collection: string): Promise<string[]> {
      const rows = db.prepare(
        'SELECT key FROM documents WHERE collection = ? ORDER BY key'
      ).all(collection) as Array<{ key: string }>;
      return rows.map(r => r.key);
    },
  };

  return {
    store,
    close: () => db.close(),
  };
}

/**
 * Create a SQLite-backed StorageProvider.
 *
 * Follows the standard provider contract: export a `create(config)` function.
 */
export async function create(_config: Config, _name?: string, _opts?: Record<string, unknown>): Promise<StorageProvider> {
  mkdirSync(dataDir(), { recursive: true });

  // Create the three existing stores using their standard factory methods
  const messageQueue = await MessageQueue.create(dataFile('messages.db'));
  const conversationStore = await ConversationStore.create();
  const sessionStore = await SessionStore.create();

  // Create the document store
  const { store: documentStore, close: closeDocuments } = await createDocumentStore(
    dataFile('documents.db')
  );

  return {
    get messages() { return wrapMessageQueue(messageQueue); },
    get conversations() { return wrapConversationStore(conversationStore); },
    get sessions() { return wrapSessionStore(sessionStore); },
    get documents() { return documentStore; },

    close(): void {
      messageQueue.close();
      conversationStore.close();
      sessionStore.close();
      closeDocuments();
    },
  };
}
