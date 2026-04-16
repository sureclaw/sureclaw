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
        └── DocumentStore — config, plugin metadata (key-value). Identity and skills are git-native.
  └── McpServerStore — `mcp_servers` table for database-backed MCP provider
  └── Cortex MemoryProvider — knowledge items, embeddings, summaries
  └── AuditProvider — audit trail
  └── AgentRegistryDb — agent registry (PostgreSQL and SQLite)

WorkspaceProvider (src/providers/workspace/)
  └── Returns git clone URLs for agent workspaces
  └── Backends: git-http (HTTP repos via k8s Service), git-local (bare repos at ~/.ax/repos/)
  └── Git operations handled host-side (local) or via git-sidecar (k8s)
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
| `src/providers/workspace/types.ts` | WorkspaceProvider interface (getRepoUrl, close) |
| `src/providers/workspace/git-http.ts` | HTTP-based workspace for k8s (creates repos via ax-git Service) |
| `src/providers/workspace/git-local.ts` | Local bare git repos at ~/.ax/repos/ |
| `src/migrations/jobs.ts` | Job schema migrations (three-part: initial, dedup, workspace) |

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
- **Used by**: Plugin metadata, config storage, migration utility. Identity and skills are git-native (not in DocumentStore).

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
- **Class**: `KyselyJobStore` — uses shared DatabaseProvider (SQLite or PostgreSQL)
- **Migration table**: `'scheduler_migration'`
- **Migrations** (`src/migrations/jobs.ts`): `jobs_001_initial` (core), `jobs_002_last_fired_at` (dedup), `jobs_003_creator_session_id` (workspace)
- **Key method**: `tryClaim(jobId, minuteKey)` — atomic CAS for multi-replica dedup
- **Fallback**: standalone SQLite at `~/.ax/data/scheduler.db` if no shared DatabaseProvider

## Workspace Provider

The `WorkspaceProvider` (`src/providers/workspace/`) provides git clone URLs for agent workspaces. Minimal interface: `getRepoUrl(agentId): Promise<{ url: string; created: boolean }>` and `close(): Promise<void>`. The `created` flag lets the host seed `.ax/` templates on first creation.

- **Backends**:
  - `git-http` — Creates repos via HTTP POST to `ax-git.{namespace}.svc.cluster.local:8000/repos`. Clone URLs are HTTP-based. Used in k8s deployments.
  - `git-local` — Creates bare repos via `git init --bare` at `~/.ax/repos/{encodedAgentId}`. Clone URLs use `file://` protocol. Used in local mode.
- **Agent ID encoding**: `encodeURIComponent(agentId)` for lossless encoding (prevents aliasing, e.g., `user:alice` vs `user-alice`)
- **Git operations**: For `git-local` (file:// URLs), host handles git clone/pull/commit. For `git-http`, agents clone directly. Git sidecar handles k8s mode.

## Common Tasks

**Adding a new sub-store to StorageProvider:**
1. Define the interface in `src/providers/storage/types.ts`
2. Implement in `src/providers/storage/database.ts`
3. Add migration in `src/providers/storage/migrations.ts`
4. Expose on `StorageProvider` interface
5. Add tests in `tests/providers/storage/database.test.ts`

## Gotchas

- **Always use shared DatabaseProvider**: Don't create standalone DB connections for new sub-stores. Inject via `CreateOptions`.
- **Job store uses shared DB**: `KyselyJobStore` uses the shared DatabaseProvider by default. Standalone SQLite fallback exists but is not recommended for production.
- **Workspace is git-based**: Old scoped workspace model (agent/user/session scopes, mount/commit lifecycle) has been replaced by simple git clone URLs. No GCS or filesystem workspace backends remain.
- **Per-subsystem migration tables**: Always pass a unique `migrationTableName` to `runMigrations()`.
- **SQLite autoincrement IDs**: After delete+insert, IDs don't respect logical ordering. Don't rely on ID order.
- **Content serialization**: `serializeContent()` strips `image_data` blocks. `deserializeContent()` detects JSON arrays by checking `[` prefix.
- **PostgreSQL dialect differences**: Use `sqlNow(dbType)` and `sqlEpoch(dbType)` from `src/migrations/dialect.ts` for cross-DB compatibility in migrations.
- **Legacy file-storage warning**: `database.ts` logs warnings if old filesystem storage directories exist.
- **Close store on shutdown**: Standalone stores expose `close()`. Wire into server shutdown.
