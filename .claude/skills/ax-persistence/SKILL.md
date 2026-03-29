---
name: ax-persistence
description: Use when modifying data persistence — StorageProvider (database-backed), conversation history, message queue, session store, document store, file store, job store, or database migration utilities
---

## Overview

AX persists data using a unified `StorageProvider` backed by the shared `DatabaseProvider` (SQLite for local dev, PostgreSQL for k8s). The StorageProvider provides four sub-stores: MessageQueue, ConversationStore, SessionStore, and DocumentStore. Additional standalone stores exist for file metadata and scheduler jobs.

## Architecture

All persistence now flows through database-backed providers:

```
DatabaseProvider (SQLite or PostgreSQL)
  └── StorageProvider (src/providers/storage/database.ts)
        ├── MessageQueueStore — inbound message lifecycle
        ├── ConversationStoreProvider — conversation history per session
        ├── SessionStoreProvider — session/channel tracking
        └── DocumentStore — identity files, skills, config (key-value)
  └── McpServerStore — `mcp_servers` table for database-backed MCP provider
  └── Cortex MemoryProvider — knowledge items, embeddings, summaries
  └── AuditProvider — audit trail
  └── AgentRegistryDb — agent registry (PostgreSQL only)

WorkspaceProvider (src/providers/workspace/)
  └── Manages persistent file workspaces with three scopes (agent, user, session)
  └── Backends: none (no-op), local (filesystem), gcs (Google Cloud Storage)
  └── Mount/commit lifecycle with change detection and scan-before-persist
```

Standalone stores (outside StorageProvider):
- `src/file-store.ts` — File metadata (fileId → agent, user, mimeType)
- `src/job-store.ts` — Scheduler job persistence for `plainjob` provider

## Key Files

| File | Responsibility |
|---|---|
| `src/providers/storage/types.ts` | StorageProvider interface with all sub-store interfaces |
| `src/providers/storage/database.ts` | Database-backed implementation (SQLite + PostgreSQL via Kysely) |
| `src/providers/storage/migrations.ts` | Storage schema migrations |
| `src/providers/storage/migrate-to-db.ts` | One-time filesystem-to-DocumentStore migration |
| `src/providers/database/types.ts` | DatabaseProvider interface (shared Kysely instance) |
| `src/providers/database/sqlite.ts` | SQLite DatabaseProvider |
| `src/providers/database/postgres.ts` | PostgreSQL DatabaseProvider |
| `src/utils/migrator.ts` | DB-agnostic migration runner |
| `src/utils/content-serialization.ts` | Content serialization for structured blocks |
| `src/utils/database.ts` | Kysely instance creation utility |
| `src/migrations/dialect.ts` | Shared SQL dialect helpers (sqlNow, sqlEpoch) |
| `src/file-store.ts` | File metadata store |
| `src/job-store.ts` | Scheduler job persistence |
| `src/providers/storage/tool-stubs.ts` | Tool stub cache (schema hash invalidation) |
| `src/providers/workspace/types.ts` | WorkspaceProvider interface (scopes, mounts, commits) |
| `src/providers/workspace/none.ts` | No-op workspace stub (default) |
| `src/providers/workspace/local.ts` | Local filesystem workspace backend |
| `src/providers/workspace/gcs.ts` | Google Cloud Storage workspace backend |
| `src/providers/workspace/shared.ts` | Shared workspace utilities (change detection, ignore patterns) |

## StorageProvider Sub-Stores

### MessageQueueStore
- **Table**: `messages` (id UUID PK, session_id, channel, sender, content, status, created_at, processed_at)
- **Statuses**: pending → processing → done | error
- **PostgreSQL**: Uses `FOR UPDATE SKIP LOCKED` for concurrent dequeue
- **SQLite**: Simple atomic `UPDATE...RETURNING`

### ConversationStoreProvider
- **Table**: `turns` (id INTEGER PK, session_id, role, sender, content, created_at, is_summary, summarized_up_to)
- **Content serialization**: `serializeContent()` handles both string and ContentBlock[]. Strips `image_data` blocks before persisting.
- **History summarization**: `replaceTurnsWithSummary()` is transactional — deletes old turns, inserts summary + retained turns atomically.
- **Retention**: Controlled by `config.history.max_turns` (default 50)

### SessionStoreProvider
- **Table**: `last_sessions` (agent_id PK, provider, scope, identifiers JSON, updated_at)
- **Purpose**: Tracks last channel session per agent for delivery resolution

### DocumentStore
- **Table**: `documents` (collection + key composite PK, content, updated_at)
- **Collections**: `identity` (SOUL.md, IDENTITY.md, etc.), `skills`, `config`, `_meta`
- **Key format**: `{agentId}/{filename}` for identity, `{agentId}/{skillPath}` for skills
- **Used by**: Identity/skills IPC handlers, host stdin payload construction, migration utility

## Migration System

- **`src/utils/migrator.ts`**: Shared `runMigrations(db, migrations, migrationTableName?)` using Kysely Migrator.
- **Per-subsystem isolation**: Each subsystem uses a unique migration table name to avoid collisions:
  - Storage: `'storage_migration'`
  - Cortex: `'cortex_migration'`
  - Agent Registry: `'registry_migration'`
- **`mcp_servers` table migration**: Added for the database-backed MCP provider, managed within the storage migrations.
- **`src/migrations/dialect.ts`**: SQL dialect helpers for SQLite/PostgreSQL compatibility.

## Standalone Stores

### FileStore (`src/file-store.ts`)
- **DB**: `~/.ax/data/files.db` (standalone SQLite)
- **Table**: `files` (file_id TEXT PK, agent_name, user_id, mime_type, created_at)
- **Purpose**: Maps fileId to metadata for file downloads

### JobStore (`src/job-store.ts`)
- **DB**: `~/.ax/data/job-store.db` (standalone SQLite)
- **Purpose**: Persists scheduled jobs for the `plainjob` scheduler provider

## Workspace Provider

The `WorkspaceProvider` (`src/providers/workspace/`) manages persistent file workspaces for agent sessions. Unlike StorageProvider which stores structured key-value data, workspace provides scoped file-system semantics:

- **Scopes**: `agent` (shared across all sessions for an agent), `user` (per-user), `session` (ephemeral per session)
- **Lifecycle**: `mount()` activates scopes and populates sandbox directories → agent works in sandbox → `commit()` diffs, scans, and persists changes → `cleanup()` tears down session scope
- **Backends**:
  - `none` — No-op stub (default). All operations succeed without persisting.
  - `local` — Local filesystem backend. Stores workspace files under a configurable base path.
  - `gcs` — Google Cloud Storage backend. Stores workspace files in GCS buckets.
- **Shared utilities** (`shared.ts`): Change detection (file diffing), ignore-pattern matching, and commit-size enforcement shared across backends.
- **Not database-backed**: Unlike most other persistence providers, workspace uses the filesystem or object storage directly rather than the shared DatabaseProvider.

## Common Tasks

**Adding a new sub-store to StorageProvider:**
1. Define the interface in `src/providers/storage/types.ts`
2. Implement in `src/providers/storage/database.ts`
3. Add migration in `src/providers/storage/migrations.ts`
4. Expose on `StorageProvider` interface
5. Add tests in `tests/providers/storage/database.test.ts`

## Gotchas

- **No standalone conversation/message/session stores**: These were consolidated into StorageProvider. The old `src/conversation-store.ts`, `src/db.ts`, `src/session-store.ts` no longer exist.
- **Always use shared DatabaseProvider**: Don't create standalone DB connections for new sub-stores. Inject via `CreateOptions`.
- **Per-subsystem migration tables**: Always pass a unique `migrationTableName` to `runMigrations()`.
- **SQLite autoincrement IDs**: After delete+insert, IDs don't respect logical ordering. Don't rely on ID order.
- **Content serialization**: `serializeContent()` strips `image_data` blocks. `deserializeContent()` detects JSON arrays by checking `[` prefix.
- **PostgreSQL dialect differences**: Use `sqlNow(dbType)` and `sqlEpoch(dbType)` from `src/migrations/dialect.ts` for cross-DB compatibility in migrations.
- **Legacy file-storage warning**: `database.ts` logs warnings if old filesystem storage directories exist.
- **Close store on shutdown**: Standalone stores expose `close()`. Wire into server shutdown.
