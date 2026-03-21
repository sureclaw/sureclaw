// src/providers/storage/database.ts — Database-backed StorageProvider
//
// Uses the shared DatabaseProvider (SQLite or PostgreSQL) for all sub-stores.
// Runs its own migrations against the shared Kysely instance.

import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { sql, type Kysely } from 'kysely';
import { runMigrations } from '../../utils/migrator.js';
import { storageMigrations } from './migrations.js';
import { serializeContent } from '../../utils/content-serialization.js';
import { dataFile } from '../../paths.js';
import type { Config, ContentBlock } from '../../types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { SessionAddress, SessionScope } from '../channel/types.js';
import type {
  StorageProvider,
  MessageQueueStore,
  ConversationStoreProvider,
  SessionStoreProvider,
  DocumentStore,
  ChatSessionStore,
  ChatSession,
  QueuedMessage,
  StoredTurn,
} from './types.js';

function createMessageQueue(db: Kysely<any>, dbType: 'sqlite' | 'postgresql'): MessageQueueStore {
  return {
    async enqueue(msg) {
      const id = randomUUID();
      await db.insertInto('messages')
        .values({
          id,
          session_id: msg.sessionId,
          channel: msg.channel,
          sender: msg.sender,
          content: msg.content,
          status: 'pending',
        })
        .execute();
      return id;
    },

    async dequeue() {
      if (dbType === 'postgresql') {
        const result = await sql<QueuedMessage>`
          UPDATE messages
          SET status = 'processing', processed_at = NOW()
          WHERE id = (
            SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *
        `.execute(db);
        return (result.rows[0] as QueuedMessage | undefined) ?? null;
      }

      // SQLite: simple atomic UPDATE...RETURNING (no row-level locking needed)
      const result = await sql<QueuedMessage>`
        UPDATE messages
        SET status = 'processing', processed_at = datetime('now')
        WHERE id = (
          SELECT id FROM messages WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1
        )
        RETURNING *
      `.execute(db);
      return (result.rows[0] as QueuedMessage | undefined) ?? null;
    },

    async dequeueById(id) {
      if (dbType === 'postgresql') {
        const result = await sql<QueuedMessage>`
          UPDATE messages
          SET status = 'processing', processed_at = NOW()
          WHERE id = ${id} AND status = 'pending'
          RETURNING *
        `.execute(db);
        return (result.rows[0] as QueuedMessage | undefined) ?? null;
      }

      const result = await sql<QueuedMessage>`
        UPDATE messages
        SET status = 'processing', processed_at = datetime('now')
        WHERE id = ${id} AND status = 'pending'
        RETURNING *
      `.execute(db);
      return (result.rows[0] as QueuedMessage | undefined) ?? null;
    },

    async complete(id) {
      await db.updateTable('messages')
        .set({ status: 'done' })
        .where('id', '=', id)
        .execute();
    },

    async fail(id) {
      await db.updateTable('messages')
        .set({ status: 'error' })
        .where('id', '=', id)
        .execute();
    },

    async pending() {
      const result = await db.selectFrom('messages')
        .select(db.fn.countAll<number>().as('count'))
        .where('status', '=', 'pending')
        .executeTakeFirstOrThrow();
      return Number(result.count);
    },
  };
}

function createConversationStore(db: Kysely<any>): ConversationStoreProvider {
  return {
    async append(sessionId, role, content, sender?) {
      const serialized = serializeContent(content);
      await db.insertInto('turns')
        .values({
          session_id: sessionId,
          role,
          sender: sender ?? null,
          content: serialized,
        })
        .execute();
    },

    async load(sessionId, maxTurns?) {
      if (maxTurns !== undefined) {
        if (maxTurns <= 0) return [];
        const result = await sql<StoredTurn>`
          SELECT * FROM (
            SELECT id, session_id, role, sender, content, created_at, is_summary, summarized_up_to
            FROM turns WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${maxTurns}
          ) sub ORDER BY id ASC
        `.execute(db);
        return result.rows as StoredTurn[];
      }
      const result = await db.selectFrom('turns')
        .select(['id', 'session_id', 'role', 'sender', 'content', 'created_at', 'is_summary', 'summarized_up_to'])
        .where('session_id', '=', sessionId)
        .orderBy('id', 'asc')
        .execute();
      return result as StoredTurn[];
    },

    async prune(sessionId, keep) {
      await sql`
        DELETE FROM turns WHERE session_id = ${sessionId} AND id NOT IN (
          SELECT id FROM turns WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${keep}
        )
      `.execute(db);
    },

    async count(sessionId) {
      const result = await db.selectFrom('turns')
        .select(db.fn.countAll<number>().as('cnt'))
        .where('session_id', '=', sessionId)
        .executeTakeFirstOrThrow();
      return Number(result.cnt);
    },

    async clear(sessionId) {
      await db.deleteFrom('turns')
        .where('session_id', '=', sessionId)
        .execute();
    },

    async loadOlderTurns(sessionId, keepRecent) {
      const result = await sql<StoredTurn>`
        SELECT id, session_id, role, sender, content, created_at, is_summary, summarized_up_to
        FROM turns
        WHERE session_id = ${sessionId} AND id NOT IN (
          SELECT id FROM turns WHERE session_id = ${sessionId} ORDER BY id DESC LIMIT ${keepRecent}
        )
        ORDER BY id ASC
      `.execute(db);
      return result.rows as StoredTurn[];
    },

    async replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent) {
      await db.transaction().execute(async (trx) => {
        const remaining = await trx.selectFrom('turns')
          .select(['role', 'sender', 'content', 'created_at', 'is_summary', 'summarized_up_to'])
          .where('session_id', '=', sessionId)
          .where('id', '>', maxIdToReplace)
          .orderBy('id', 'asc')
          .execute();

        await trx.deleteFrom('turns')
          .where('session_id', '=', sessionId)
          .execute();

        await trx.insertInto('turns')
          .values({
            session_id: sessionId,
            role: 'user',
            sender: null,
            content: summaryContent,
            is_summary: 1,
            summarized_up_to: maxIdToReplace,
          })
          .execute();

        await trx.insertInto('turns')
          .values({
            session_id: sessionId,
            role: 'assistant',
            sender: null,
            content: 'Understood. I have the conversation context from the summary above.',
            is_summary: 1,
            summarized_up_to: maxIdToReplace,
          })
          .execute();

        for (const t of remaining) {
          await trx.insertInto('turns')
            .values({
              session_id: sessionId,
              role: t.role,
              sender: t.sender,
              content: t.content,
              is_summary: t.is_summary,
              summarized_up_to: t.summarized_up_to,
            })
            .execute();
        }
      });
    },
  };
}

function createSessionStore(db: Kysely<any>): SessionStoreProvider {
  return {
    async trackSession(agentId, session) {
      await sql`
        INSERT INTO last_sessions (agent_id, provider, scope, identifiers, updated_at)
        VALUES (${agentId}, ${session.provider}, ${session.scope}, ${JSON.stringify(session.identifiers)}, ${Date.now()})
        ON CONFLICT (agent_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          scope = EXCLUDED.scope,
          identifiers = EXCLUDED.identifiers,
          updated_at = EXCLUDED.updated_at
      `.execute(db);
    },

    async getLastChannelSession(agentId) {
      const row = await db.selectFrom('last_sessions')
        .select(['provider', 'scope', 'identifiers'])
        .where('agent_id', '=', agentId)
        .executeTakeFirst();
      if (!row) return undefined;
      return {
        provider: row.provider as string,
        scope: row.scope as SessionScope,
        identifiers: JSON.parse(row.identifiers as string),
      };
    },
  };
}

function createDocumentStore(db: Kysely<any>, dbType: 'sqlite' | 'postgresql'): DocumentStore {
  return {
    async get(collection, key) {
      const row = await db.selectFrom('documents')
        .select('content')
        .where('collection', '=', collection)
        .where('key', '=', key)
        .executeTakeFirst();
      return (row?.content as string) ?? undefined;
    },

    async put(collection, key, content) {
      const now = dbType === 'sqlite' ? sql`datetime('now')` : sql`NOW()`;
      await sql`
        INSERT INTO documents (collection, key, content, updated_at)
        VALUES (${collection}, ${key}, ${content}, ${now})
        ON CONFLICT (collection, key) DO UPDATE SET
          content = EXCLUDED.content,
          updated_at = ${now}
      `.execute(db);
    },

    async delete(collection, key) {
      const result = await db.deleteFrom('documents')
        .where('collection', '=', collection)
        .where('key', '=', key)
        .executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },

    async list(collection) {
      const rows = await db.selectFrom('documents')
        .select('key')
        .where('collection', '=', collection)
        .orderBy('key', 'asc')
        .execute();
      return rows.map(r => r.key as string);
    },
  };
}

function createChatSessionStore(db: Kysely<any>): ChatSessionStore {
  return {
    async list() {
      const rows = await db.selectFrom('chat_sessions')
        .selectAll()
        .where('status', '=', 'active')
        .orderBy('updated_at', 'desc')
        .execute();
      return rows as ChatSession[];
    },

    async create(opts) {
      const id = opts.id ?? randomUUID();
      const now = Math.floor(Date.now() / 1000);
      await db.insertInto('chat_sessions')
        .values({
          id,
          title: opts.title ?? null,
          status: 'active',
          created_at: now,
          updated_at: now,
        })
        .execute();
      return { id, title: opts.title ?? null, status: 'active', created_at: now, updated_at: now };
    },

    async updateTitle(id, title) {
      const now = Math.floor(Date.now() / 1000);
      await db.updateTable('chat_sessions')
        .set({ title, updated_at: now })
        .where('id', '=', id)
        .execute();
    },

    async ensureExists(id) {
      const now = Math.floor(Date.now() / 1000);
      const existing = await db.selectFrom('chat_sessions')
        .select('id')
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing) {
        await db.updateTable('chat_sessions')
          .set({ updated_at: now })
          .where('id', '=', id)
          .execute();
      } else {
        await db.insertInto('chat_sessions')
          .values({ id, status: 'active', created_at: now, updated_at: now })
          .execute();
      }
    },
  };
}

/**
 * One-time check for leftover file-based storage directories.
 * Logs a warning so users know the old data is no longer used.
 */
function warnAboutLegacyFileStorage(): void {
  const legacyDirs = [
    dataFile('messages'),
    dataFile('conversations'),
    dataFile('sessions'),
  ];
  const found = legacyDirs.filter(d => existsSync(d));
  if (found.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      '[ax] Legacy file-based storage directories detected:\n' +
      found.map(d => `  ${d}`).join('\n') + '\n' +
      'These are no longer used — all storage is now database-backed.\n' +
      'You can safely remove them once you have confirmed no data loss.',
    );
  }
}

export interface CreateOptions {
  database?: DatabaseProvider;
}

export async function create(
  _config: Config,
  _name?: string,
  opts?: CreateOptions,
): Promise<StorageProvider> {
  warnAboutLegacyFileStorage();

  const database = opts?.database;
  if (!database) {
    throw new Error(
      'storage/database requires a database provider. Set providers.database in ax.yaml.',
    );
  }

  const result = await runMigrations(database.db, storageMigrations(database.type), 'storage_migration');
  if (result.error) throw result.error;

  const db = database.db;
  const dbType = database.type;

  return {
    get messages() { return createMessageQueue(db, dbType); },
    get conversations() { return createConversationStore(db); },
    get sessions() { return createSessionStore(db); },
    get documents() { return createDocumentStore(db, dbType); },
    get chatSessions() { return createChatSessionStore(db); },

    close(): void {
      // No-op: the shared DatabaseProvider owns the connection lifecycle.
    },
  };
}
