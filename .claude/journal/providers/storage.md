# Storage Provider Journal

## [2026-03-13 08:30] -- Phase 1A: Migration utility for filesystem to DocumentStore

**Task:** Create a one-time migration utility that imports filesystem-based identity and skills files into the DocumentStore (SQLite documents table) on first boot after upgrade.
**What I did:** Implemented `migrateFilesToDb()` function that scans `~/.ax/agents/` for identity files (identity/*.md, BOOTSTRAP.md, USER_BOOTSTRAP.md), agent skills (skills/**/*.md), user identity (USER.md), and user skills. Each file is stored via `documents.put()` with appropriate collection ('identity' or 'skills') and key format. Skills keys strip the .md extension. A `_meta/migrated_storage_v1` flag ensures idempotency. Wrote 19 comprehensive tests using real SQLite-backed DocumentStore with temp directories.
**Files touched:**
  - Created: src/providers/storage/migrate-to-db.ts, tests/providers/storage/migrate-to-db.test.ts
**Outcome:** Success. All 19 tests pass. Existing database storage tests (18) still pass.
**Notes:** Used async fs operations (readdir, readFile from node:fs/promises) for the migration. The `collectMdFiles()` helper recursively walks directories and returns relative paths. Error handling logs warnings for unreadable files but continues migration.

## [2026-03-04 21:00] -- PostgreSQL StorageProvider + async interface migration

**Task:** Implement PostgreSQL StorageProvider (Phase 2 Task 4). Migrate all storage interfaces from sync to async to support PostgreSQL's async API.
**What I did:** (1) Rewrote storage/types.ts with new async interfaces (MessageQueueStore, ConversationStoreProvider, SessionStoreProvider, DocumentStore). (2) Created async wrappers for SQLite sync classes. (3) Created src/providers/storage/postgresql.ts using Kysely + pg Pool. (4) Created src/migrations/postgresql.ts with PG-compatible migrations. (5) Updated ~25 call sites across router.ts, server-completions.ts, history-summarizer.ts, server-channels.ts, delivery.ts, server.ts. (6) Updated all test files with `await`.
**Files touched:**
  - Created: src/providers/storage/postgresql.ts, src/migrations/postgresql.ts
  - Modified: src/providers/storage/types.ts, src/providers/storage/sqlite.ts, src/host/router.ts, src/host/server-completions.ts, src/host/history-summarizer.ts, src/host/server-channels.ts, src/host/delivery.ts, src/host/server.ts, src/host/provider-map.ts, src/utils/database.ts, tests/providers/storage/sqlite.test.ts, tests/host/delivery.test.ts, tests/integration/cross-component.test.ts
**Outcome:** Success. 2332+ tests pass, 3 pre-existing failures only.
**Notes:** Biggest blast radius change — sync-to-async migration touched many call sites. Key pattern: define new async interfaces, wrap existing sync implementations in Promise wrappers.

## [2026-03-04 18:30] -- Implement StorageProvider interface + SQLite implementation

**Task:** Create the StorageProvider abstraction with a SQLite implementation that wraps MessageQueue, ConversationStore, SessionStore, and adds a DocumentStore for key-value storage. Phase 1 of K8s agent compute architecture.
**What I did:** Defined StorageProvider interface in types.ts with sub-interfaces for the 3 existing stores plus DocumentStore. Created SQLite implementation that delegates to existing classes and adds a documents table. Updated provider-map, registry, config, types, and server.ts to wire it in. Created comprehensive tests for all sub-stores.
**Files touched:**
  - Created: src/providers/storage/types.ts, src/providers/storage/sqlite.ts, src/migrations/documents.ts, tests/providers/storage/sqlite.test.ts
  - Modified: src/host/provider-map.ts, src/host/registry.ts, src/types.ts, src/config.ts, src/host/server.ts
**Outcome:** Success. Build passes, all 16 new tests pass, full test suite passes (2317/2320 pass; 3 pre-existing failures in skills-install unrelated to changes).
**Notes:** Documents table includes `data BLOB` column (for Phase 2 binary storage) even though current interface only uses text `content`. Migration uses raw SQL for composite PRIMARY KEY.
