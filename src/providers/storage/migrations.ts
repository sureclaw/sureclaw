// src/providers/storage/migrations.ts — Dialect-aware storage migrations
import { sql, type Kysely } from 'kysely';
import type { MigrationSet } from '../../utils/migrator.js';

/**
 * Build storage migrations for the given database dialect.
 * Uses the same logical schema but adapts timestamp defaults and
 * autoincrement syntax for SQLite vs PostgreSQL.
 */
export function storageMigrations(dbType: 'sqlite' | 'postgresql'): MigrationSet {
  const isSqlite = dbType === 'sqlite';

  return {
    storage_001_messages: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('messages')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('session_id', 'text', col => col.notNull())
          .addColumn('channel', 'text', col => col.notNull())
          .addColumn('sender', 'text', col => col.notNull())
          .addColumn('content', 'text', col => col.notNull())
          .addColumn('status', 'text', col => col.notNull().defaultTo('pending'))
          .addColumn('created_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .addColumn('processed_at', isSqlite ? 'text' : 'timestamptz')
          .execute();

        await db.schema
          .createIndex('idx_messages_status')
          .ifNotExists()
          .on('messages')
          .column('status')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('messages').ifExists().execute();
      },
    },

    storage_002_turns: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await db.schema
            .createTable('turns')
            .ifNotExists()
            .addColumn('id', 'integer', col => col.primaryKey().autoIncrement())
            .addColumn('session_id', 'text', col => col.notNull())
            .addColumn('role', 'text', col => col.notNull())
            .addColumn('sender', 'text')
            .addColumn('content', 'text', col => col.notNull())
            .addColumn('created_at', 'integer', col =>
              col.notNull().defaultTo(sql`(unixepoch())`))
            .addColumn('is_summary', 'integer', col => col.notNull().defaultTo(0))
            .addColumn('summarized_up_to', 'integer')
            .execute();
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS turns (
              id SERIAL PRIMARY KEY,
              session_id TEXT NOT NULL,
              role TEXT NOT NULL,
              sender TEXT,
              content TEXT NOT NULL,
              created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
              is_summary INTEGER NOT NULL DEFAULT 0,
              summarized_up_to INTEGER
            )
          `.execute(db);
        }

        await db.schema
          .createIndex('idx_turns_session')
          .ifNotExists()
          .on('turns')
          .columns(['session_id', 'id'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('turns').ifExists().execute();
      },
    },

    storage_003_last_sessions: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('last_sessions')
          .ifNotExists()
          .addColumn('agent_id', 'text', col => col.primaryKey())
          .addColumn('provider', 'text', col => col.notNull())
          .addColumn('scope', 'text', col => col.notNull())
          .addColumn('identifiers', 'text', col => col.notNull())
          .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col => col.notNull())
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('last_sessions').ifExists().execute();
      },
    },

    storage_004_documents: {
      async up(db: Kysely<any>) {
        if (isSqlite) {
          await sql`
            CREATE TABLE IF NOT EXISTS documents (
              collection TEXT NOT NULL,
              key        TEXT NOT NULL,
              content    TEXT NOT NULL,
              data       BLOB,
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (collection, key)
            )
          `.execute(db);
        } else {
          await sql`
            CREATE TABLE IF NOT EXISTS documents (
              collection TEXT NOT NULL,
              key TEXT NOT NULL,
              content TEXT NOT NULL,
              data BYTEA,
              updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              PRIMARY KEY (collection, key)
            )
          `.execute(db);
        }
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('documents').ifExists().execute();
      },
    },

    storage_005_chat_sessions: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('chat_sessions')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('title', 'text')
          .addColumn('status', 'text', col => col.notNull().defaultTo('active'))
          .addColumn('created_at', isSqlite ? 'integer' : 'bigint', col =>
            col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
          .addColumn('updated_at', isSqlite ? 'integer' : 'bigint', col =>
            col.notNull().defaultTo(isSqlite ? sql`(unixepoch())` : sql`EXTRACT(EPOCH FROM NOW())::BIGINT`))
          .execute();

        await db.schema
          .createIndex('idx_chat_sessions_updated')
          .ifNotExists()
          .on('chat_sessions')
          .column('updated_at')
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('chat_sessions').ifExists().execute();
      },
    },

    storage_006_mcp_servers: {
      async up(db: Kysely<any>) {
        await db.schema
          .createTable('mcp_servers')
          .ifNotExists()
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('name', 'text', col => col.notNull())
          .addColumn('url', 'text', col => col.notNull())
          .addColumn('headers', 'text')
          .addColumn('enabled', 'integer', col => col.notNull().defaultTo(1))
          .addColumn('created_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .addColumn('updated_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .execute();

        await db.schema
          .createIndex('idx_mcp_servers_agent')
          .ifNotExists()
          .on('mcp_servers')
          .column('agent_id')
          .execute();

        await db.schema
          .createIndex('idx_mcp_servers_unique')
          .ifNotExists()
          .unique()
          .on('mcp_servers')
          .columns(['agent_id', 'name'])
          .execute();
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('mcp_servers').ifExists().execute();
      },
    },

    // Migration 007: MCP servers are now global (no agent_id).
    // Recreate table without agent_id, add agent_mcp_servers join table.
    storage_007_global_mcp_servers: {
      async up(db: Kysely<any>) {
        // 1. Create new table structure
        await db.schema
          .createTable('mcp_servers_new')
          .addColumn('id', 'text', col => col.primaryKey())
          .addColumn('name', 'text', col => col.notNull().unique())
          .addColumn('url', 'text', col => col.notNull())
          .addColumn('headers', 'text')
          .addColumn('enabled', 'integer', col => col.notNull().defaultTo(1))
          .addColumn('created_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .addColumn('updated_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .execute();

        // 2. Copy distinct servers (deduplicate by name, keep first seen)
        if (isSqlite) {
          await sql`
            INSERT OR IGNORE INTO mcp_servers_new (id, name, url, headers, enabled, created_at, updated_at)
            SELECT id, name, url, headers, enabled, created_at, updated_at
            FROM mcp_servers
            GROUP BY name
          `.execute(db);
        } else {
          await sql`
            INSERT INTO mcp_servers_new (id, name, url, headers, enabled, created_at, updated_at)
            SELECT DISTINCT ON (name) id, name, url, headers, enabled, created_at, updated_at
            FROM mcp_servers
            ORDER BY name, updated_at DESC
            ON CONFLICT (name) DO NOTHING
          `.execute(db);
        }

        // 3. Create join table for per-agent assignment
        await db.schema
          .createTable('agent_mcp_servers')
          .addColumn('agent_id', 'text', col => col.notNull())
          .addColumn('server_name', 'text', col => col.notNull())
          .addColumn('assigned_at', isSqlite ? 'text' : 'timestamptz', col =>
            col.notNull().defaultTo(isSqlite ? sql`(datetime('now'))` : sql`NOW()`))
          .execute();

        await db.schema
          .createIndex('idx_agent_mcp_servers_unique')
          .unique()
          .on('agent_mcp_servers')
          .columns(['agent_id', 'server_name'])
          .execute();

        await db.schema
          .createIndex('idx_agent_mcp_servers_agent')
          .on('agent_mcp_servers')
          .column('agent_id')
          .execute();

        // 4. Populate join table from old per-agent data
        if (isSqlite) {
          await sql`
            INSERT OR IGNORE INTO agent_mcp_servers (agent_id, server_name)
            SELECT agent_id, name FROM mcp_servers
            WHERE agent_id != '__global__'
          `.execute(db);
        } else {
          await sql`
            INSERT INTO agent_mcp_servers (agent_id, server_name)
            SELECT agent_id, name FROM mcp_servers
            WHERE agent_id != '__global__'
            ON CONFLICT (agent_id, server_name) DO NOTHING
          `.execute(db);
        }

        // 5. Swap tables
        await db.schema.dropTable('mcp_servers').execute();
        if (isSqlite) {
          await sql`ALTER TABLE mcp_servers_new RENAME TO mcp_servers`.execute(db);
        } else {
          await sql`ALTER TABLE "mcp_servers_new" RENAME TO "mcp_servers"`.execute(db);
        }
      },
      async down(db: Kysely<any>) {
        await db.schema.dropTable('agent_mcp_servers').ifExists().execute();
      },
    },

    // Migration 008: Drop retired 'plugins' and 'skills' rows from the
    // documents table. Phase 7 cleanup — the plugin-install path and the
    // legacy DocumentStore-backed skills were retired. Reads moved to
    // host/skills/state-store.ts and git-native skills under .ax/skills/.
    // Note: the `documents` table uses `collection` (not `kind`) as the
    // discriminator column. We keep the table itself — other collections
    // still live there.
    storage_008_drop_legacy_documents: {
      async up(db: Kysely<any>) {
        // Safe no-op when the `documents` table doesn't exist yet (fresh
        // installs that skip storage_004 for some reason, or DBs that were
        // wiped). We narrow the suppression to the specific "documents table
        // is missing" case — anything else (missing column, syntax error,
        // permission denied, undefined function) bubbles up as a genuine
        // migration failure.
        try {
          await db
            .deleteFrom('documents')
            .where('collection', 'in', ['plugins', 'skills'])
            .execute();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const code = typeof err === 'object' && err !== null && 'code' in err
            ? String((err as { code?: unknown }).code)
            : undefined;
          // SQLite: `no such table: documents` (with optional schema prefix).
          // Postgres: SQLSTATE 42P01 `relation "documents" does not exist`.
          const isMissingDocumentsTable =
            code === '42P01' ||
            /no such table:\s*(?:\w+\.)?documents\b/i.test(msg) ||
            /relation\s+"?(?:\w+\.)?documents"?\s+does not exist/i.test(msg);
          if (!isMissingDocumentsTable) throw err;
        }
      },
      async down(_db: Kysely<any>) {
        // No-op: this is a one-way cleanup. We don't resurrect retired data.
      },
    },
  };
}
