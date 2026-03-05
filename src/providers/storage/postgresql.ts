// src/providers/storage/postgresql.ts — PostgreSQL StorageProvider implementation
//
// Uses Kysely for migrations and pg Pool for runtime queries.
// Designed for k8s deployments with shared Cloud SQL (PostgreSQL).

import { randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createRequire } from 'node:module';
import { runMigrations } from '../../utils/migrator.js';
import { postgresqlMigrations } from '../../migrations/postgresql.js';
import { serializeContent } from '../../conversation-store.js';
import type { Config, ContentBlock } from '../../types.js';
import type { SessionAddress, SessionScope } from '../channel/types.js';
import type {
  StorageProvider,
  MessageQueueStore,
  ConversationStoreProvider,
  SessionStoreProvider,
  DocumentStore,
  QueuedMessage,
  StoredTurn,
} from './types.js';

// Lazy-load pg to avoid requiring it when using SQLite
const req = createRequire(import.meta.url);
const { Pool } = req('pg');
type PgPool = InstanceType<typeof Pool>;

/**
 * Create a Kysely instance for PostgreSQL using pg Pool.
 */
function createPgKysely(connectionString: string): { db: Kysely<any>; pool: PgPool } {
  const pool = new Pool({ connectionString }) as PgPool;
  const db = new Kysely({
    dialect: new PostgresDialect({ pool }),
  });
  return { db, pool };
}

/**
 * Create the MessageQueueStore backed by PostgreSQL.
 */
function createMessageQueue(db: Kysely<any>): MessageQueueStore {
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
      // Use PostgreSQL's UPDATE...RETURNING with a subquery for atomic dequeue
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
    },

    async dequeueById(id) {
      const result = await sql<QueuedMessage>`
        UPDATE messages
        SET status = 'processing', processed_at = NOW()
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

/**
 * Create the ConversationStoreProvider backed by PostgreSQL.
 */
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
        // Subquery to get last N turns, then re-order ascending
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
      // Delete turns older than the last `keep` for a session
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
        // Snapshot remaining (newer) turns before deleting
        const remaining = await trx.selectFrom('turns')
          .select(['role', 'sender', 'content', 'created_at', 'is_summary', 'summarized_up_to'])
          .where('session_id', '=', sessionId)
          .where('id', '>', maxIdToReplace)
          .orderBy('id', 'asc')
          .execute();

        // Delete ALL turns for this session
        await trx.deleteFrom('turns')
          .where('session_id', '=', sessionId)
          .execute();

        // Insert summary pair first (gets lowest new IDs)
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

        // Re-insert remaining turns in their original order
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

/**
 * Create the SessionStoreProvider backed by PostgreSQL.
 */
function createSessionStore(db: Kysely<any>): SessionStoreProvider {
  return {
    async trackSession(agentId, session) {
      // Upsert: insert or update on conflict
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

/**
 * Create the DocumentStore backed by PostgreSQL.
 */
function createDocumentStore(db: Kysely<any>): DocumentStore {
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
      await sql`
        INSERT INTO documents (collection, key, content, updated_at)
        VALUES (${collection}, ${key}, ${content}, NOW())
        ON CONFLICT (collection, key) DO UPDATE SET
          content = EXCLUDED.content,
          updated_at = NOW()
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

/**
 * Create a PostgreSQL-backed StorageProvider.
 *
 * Follows the standard provider contract: export a `create(config)` function.
 *
 * Expects the config to include a `POSTGRESQL_URL` environment variable
 * or a `database_url` config field for the connection string.
 */
export async function create(config: Config, _name?: string, _opts?: Record<string, unknown>): Promise<StorageProvider> {
  const connectionString = process.env.POSTGRESQL_URL
    ?? process.env.DATABASE_URL
    ?? 'postgresql://localhost:5432/ax';

  const { db, pool } = createPgKysely(connectionString);

  // Run all PostgreSQL migrations
  const result = await runMigrations(db, postgresqlMigrations);
  if (result.error) {
    await db.destroy();
    throw result.error;
  }

  return {
    get messages() { return createMessageQueue(db); },
    get conversations() { return createConversationStore(db); },
    get sessions() { return createSessionStore(db); },
    get documents() { return createDocumentStore(db); },

    close(): void {
      // Kysely.destroy() returns a Promise but close() is sync by interface.
      // Fire-and-forget: pool will drain connections gracefully.
      db.destroy().catch(() => {});
    },
  };
}
