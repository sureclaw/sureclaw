---
name: ax-provider-storage
description: Use when modifying persistent storage — message queues, conversations, sessions, documents, or database storage backend in src/providers/storage/
---

## Overview

Unified persistent storage abstraction with five sub-stores: MessageQueue, ConversationStore, SessionStore, DocumentStore, and ChatSessionStore. Single database-backed implementation (SQLite/PostgreSQL via shared DatabaseProvider). All operations are async.

## Interface (`src/providers/storage/types.ts`)

### StorageProvider

| Field           | Type                       | Notes                          |
|-----------------|----------------------------|--------------------------------|
| `messages`      | `MessageQueueStore`        | Enqueue/dequeue message queue  |
| `conversations` | `ConversationStoreProvider`| Conversation history           |
| `sessions`      | `SessionStoreProvider`     | Session tracking               |
| `documents`     | `DocumentStore`            | Key-value document store       |
| `chatSessions`  | `ChatSessionStore`         | Chat UI session management     |
| `close()`       | `void`                     | Tear down connections          |

### MessageQueueStore

| Method           | Description                              |
|------------------|------------------------------------------|
| `enqueue(msg)`   | Add message to queue; returns ID         |
| `dequeue()`      | Pop next pending message (or null)       |
| `dequeueById(id)`| Pop specific message by ID               |
| `complete(id)`   | Mark message as completed                |
| `fail(id)`       | Mark message as failed                   |
| `pending()`      | Count of pending messages                |

### ConversationStoreProvider

| Method                                        | Description                                    |
|-----------------------------------------------|------------------------------------------------|
| `append(sessionId, role, content, sender?)`   | Add a turn to conversation                     |
| `load(sessionId, maxTurns?)`                  | Load conversation history                      |
| `prune(sessionId, keep)`                      | Keep only the last N turns                     |
| `count(sessionId)`                            | Number of turns in session                     |
| `clear(sessionId)`                            | Delete all turns                               |
| `loadOlderTurns(sessionId, keepRecent)`       | Load turns older than keepRecent               |
| `replaceTurnsWithSummary(sessionId, maxIdToReplace, summaryContent)` | Replace old turns with summary |

### SessionStoreProvider

| Method                          | Description                              |
|---------------------------------|------------------------------------------|
| `trackSession(agentId, session)`| Record a session address                 |
| `getLastChannelSession(agentId)`| Get most recent session for an agent     |

### DocumentStore

| Method                     | Description                              |
|----------------------------|------------------------------------------|
| `get(collection, key)`    | Retrieve document content                |
| `put(collection, key, content)` | Store/upsert document               |
| `delete(collection, key)` | Delete document; returns boolean         |
| `list(collection)`        | List all keys in collection              |

## Implementation

| Provider   | File          | Backend                | Notes                                      |
|------------|---------------|------------------------|--------------------------------------------|
| `database` | `database.ts` | Shared DatabaseProvider | SQLite or PostgreSQL via Kysely            |

Provider map entries in `src/host/provider-map.ts`:
```
storage: {
  database: '../providers/storage/database.js',
}
```

## Database Provider Details

- Requires injected `DatabaseProvider` via `CreateOptions`; throws if missing.
- Migrations in `migrations.ts` — applied during startup.
- PostgreSQL `dequeue()` uses `FOR UPDATE SKIP LOCKED` for concurrent access; SQLite uses simple `LIMIT 1`.
- Document store does `ON CONFLICT` upsert (syntax differs between SQLite and PostgreSQL via sql template).
- `replaceTurnsWithSummary` is transactional (database) vs. manual multi-step (file) — atomicity guarantees differ.

## Common Tasks

**Adding a new sub-store:**
1. Define the interface in `types.ts`.
2. Implement in `database.ts`.
3. Add migration in `migrations.ts` for the database tables.
4. Expose on `StorageProvider` interface.
5. Add tests.

**Adding a new storage backend:**
1. Create `src/providers/storage/<name>.ts` implementing `StorageProvider`.
2. Export `create(config: Config)`.
3. Add entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add tests in `tests/providers/storage/<name>.test.ts`.

## DocumentStore

Key-value document storage for identity files, skills, config, etc. Documents are organized by `collection` (e.g. 'identity', 'skills', 'config') and keyed by a unique string within each collection. Used by identity/skills IPC handlers and the migration utility.

## Migration Utility (`migrate-to-db.ts`)

One-time migration of filesystem-based identity/skills files into DocumentStore:
- **`migrateFilesToDb(documents, axHomePath, log?)`** — Scans `~/.ax/agents/` for identity files, bootstrap files, skills, and user data.
- **Idempotent**: Writes `_meta/migrated_storage_v1` flag to prevent re-running.
- **Collections**: `identity` (SOUL.md, IDENTITY.md, BOOTSTRAP.md, USER.md), `skills` (agent and user skills).
- **Key format**: `{agentId}/{filename}` for identity, `{agentId}/{skillPath}` for skills.

## Content Serialization

Uses `src/utils/content-serialization.ts`:
- **`serializeContent(content)`** — Strings stored as-is, ContentBlock[] JSON-stringified. Strips `image_data` blocks before persisting.
- **`deserializeContent(raw)`** — Detects JSON arrays by checking if string starts with `[`.

## Gotchas

- **Database requires injected DatabaseProvider**: Don't create standalone DB connections — use the shared `DatabaseProvider` from `CreateOptions`.
- **SQLite autoincrement IDs**: After delete+insert, IDs don't respect logical ordering. Don't rely on ID order for conversation turn ordering.
- **Creating a MessageQueueStore in tests**: Requires full storage provider setup, not just the sub-store.
- **Structured content serialization**: Uses JSON detection on load — content can be string or structured object.
- **Legacy file-storage warning**: On startup, if old `~/.ax/data/messages/`, `conversations/`, or `sessions/` directories exist, a deprecation warning is logged. File-based storage has been completely removed.
- **Migration idempotency**: `migrateFilesToDb` checks for `_meta/migrated_storage_v1` flag. Don't call `documents.put` on the meta key manually.
- **Per-subsystem migration tables**: Each subsystem using the shared DatabaseProvider MUST pass a unique `migrationTableName` to `runMigrations()` to avoid history collisions (e.g. `'storage_migration'`).

## Key Files

- `src/providers/storage/types.ts` — Interface definitions (StorageProvider, MessageQueueStore, ConversationStoreProvider, SessionStoreProvider, DocumentStore)
- `src/providers/storage/database.ts` — Database-backed implementation (SQLite + PostgreSQL via Kysely)
- `src/providers/storage/migrations.ts` — Database schema migrations
- `src/providers/storage/migrate-to-db.ts` — One-time filesystem-to-DocumentStore migration utility
- `src/utils/content-serialization.ts` — Content serialization/deserialization helpers
- `src/utils/migrator.ts` — Shared DB-agnostic migration runner
- `tests/providers/storage/database.test.ts`
- `tests/providers/storage/migrate-to-db.test.ts`
