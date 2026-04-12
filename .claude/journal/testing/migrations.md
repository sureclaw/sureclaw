# Testing: Migrations

Kysely migration infrastructure: runner, database factory, store integration, upgrade-path tests.

## [2026-04-06 10:25] — Update tests for single workspace model (Phase 5)

**Task:** Update all remaining tests for the single workspace model (PVC workspace plan Phase 5)
**What I did:** Grepped tests/ for 14 old workspace patterns. Fixed docker-nats.ts test provider: removed workspaceLocation field, replaced CANONICAL.scratch/agent/user with CANONICAL.root, removed agentWorkspace/userWorkspace/agentWorkspaceWritable/userWorkspaceWritable references. Verified sandbox-isolation.test.ts negative assertions are correct (they check old fields DON'T exist). Verified server-files/file-attachments mocks of userWorkspaceDir are correct (production code still uses it via deprecated path).
**Files touched:** tests/providers/sandbox/docker-nats.ts
**Outcome:** Success — build passes, 2590 tests pass (3 pre-existing failures unrelated to workspace)
**Notes:** The userWorkspaceDir mock in server-files tests is still correct because the production code (server-files.ts, server-channels.ts, ipc-handlers/llm.ts) still imports it. It's marked @deprecated but not yet removed. The sandbox-isolation.test.ts assertions are all negative (not.toContain) verifying the old fields are gone from production — good regression tests to keep.

## [2026-03-31 06:30] — Fix 25 test failures from double-migration and stale global-MCP assumptions

**Task:** Fix 25 failing tests across 8 test files
**What I did:** Root-caused 3 distinct issues:
1. **Double-migration collision (20 tests):** 4 test files called `runMigrations()` before `createStorage()`, which also runs migrations internally. Different tracking table names (`kysely_migration` vs `storage_migration`) caused migration 006 to re-run after 007 had already removed the `agent_id` column. Fix: removed the redundant `runMigrations()` calls.
2. **Mock not collection-aware (2 tests):** `server-admin.test.ts` mock `documents.list` returned identity docs for ALL collections including `'skills'`. Fix: made mock collection-aware.
3. **Stale per-agent MCP assumptions (3 tests):** `McpConnectionManager` was refactored to a global registry but tests expected per-agent isolation. Fix: updated test assertions to match global behavior.
**Files touched:** tests/host/router.test.ts, tests/integration/e2e.test.ts, tests/integration/phase1.test.ts, tests/integration/phase2.test.ts, tests/host/server-admin.test.ts, tests/plugins/startup.test.ts, tests/plugins/install.test.ts, tests/agent/prompt/modules/skills.test.ts
**Outcome:** Success — all 2753 tests pass
**Notes:** All failures were pre-existing on main, not introduced by the ui-fixes branch.

## [2026-03-05 20:00] — Migrate 5 test files from deleted MessageQueue to Kysely-backed MessageQueueStore

**Task:** Fix 5 test files that imported `MessageQueue` from the now-deleted `src/db.js`
**What I did:** Replaced all imports with Kysely-backed storage provider pattern: create a Kysely DB, run storage migrations, create storage via `create()`, use `storage.messages` as the `MessageQueueStore`. Made all previously-synchronous calls (`dequeue()`, `pending()`, `complete()`, `close()`) properly async with `await`.
**Files touched:** tests/e2e/harness.ts, tests/host/router.test.ts, tests/integration/phase1.test.ts, tests/integration/e2e.test.ts, tests/integration/phase2.test.ts
**Outcome:** Success — all 5 files compile cleanly with `npx tsc --noEmit`
**Notes:** For cleanup, used `kyselyDb.destroy()` instead of the old `db.close()`. For the E2E harness `dispose()` method, kept it synchronous using `void kyselyDb.destroy()` to avoid breaking 15+ scenario test callers that don't `await` dispose. For phase1/phase2, created a shared `createMessageQueueStore()` helper returning `{ db, destroy }`.

## [2026-03-05 19:10] — Port plainjob.test.ts from SQLiteJobStore to KyselyJobStore

**Task:** Replace removed `SQLiteJobStore` and `openDatabase` imports with `KyselyJobStore`, `createKyselyDb`, `runMigrations`, and `jobsMigrations` in plainjob.test.ts
**What I did:** Replaced all `SQLiteJobStore` usages with `KyselyJobStore` (with `createKyselyDb` + `runMigrations`). Added `await` to all async store methods (set/get/delete/list/setRunAt/listWithRunAt/close). Made beforeEach/afterEach async. Added microtask yields after `checkCronNow` calls since `checkCronJobs` is now async. Used `store.list()` directly instead of `scheduler.listJobs()` for KyselyJobStore persistence tests since `listJobs()` returns `[]` for async stores.
**Files touched:** tests/providers/scheduler/plainjob.test.ts
**Outcome:** Success — all 35 tests pass
**Notes:** `checkCronNow` calls `checkCronJobs` without await (fire-and-forget async). With MemoryJobStore this works because `list()` is sync, but the async function itself still returns a Promise. Tests need a small delay (`setTimeout(r, 10)`) after `checkCronNow` to let the async operation complete.

## [2026-03-05 19:05] — Await async scheduler methods in full.test.ts

**Task:** Fix scheduler full.test.ts after checkCronNow and listJobs became async (returning Promises)
**What I did:** Added `await` to all 9 `scheduler.checkCronNow!()` calls and all 8 `scheduler.listJobs!()` calls. Also updated the `jobListDuringHandler` type annotation from `ReturnType` to `Awaited<ReturnType>` since `listJobs` now returns a Promise.
**Files touched:** `tests/providers/scheduler/full.test.ts`
**Outcome:** Success — all 21 scheduler tests pass
**Notes:** `addCron`, `removeCron`, and `scheduleOnce` remain synchronous in the full.ts implementation, so those calls did not need `await`.

## [2026-03-05 19:02] — Fix server-files.test.ts for DatabaseProvider refactor

**Task:** Fix two test cases in server-files.test.ts that called `FileStore.create(path)` after `FileStore.create` was changed to accept an optional `DatabaseProvider` instead of a string path.
**What I did:** Imported `createKyselyDb`, `runMigrations`, and `filesMigrations`. Replaced `FileStore.create(join(tmpDir, 'files.db'))` with manual Kysely DB creation, migration, and `new FileStore(db)`. Added `await` to `fileStore.register()` and `fileStore.close()` calls since they are now async.
**Files touched:** tests/host/server-files.test.ts
**Outcome:** Success — all 10 tests pass.
**Notes:** After the database refactor, FileStore no longer accepts a path string. Tests must create their own Kysely instance + run migrations directly.

## [2026-02-22 18:13] — Add upgrade-path tests and guard memory migration

**Task:** Verify backwards compatibility with existing databases and fix memory_002 migration
**What I did:** Added try-catch to memory_002_add_agent_id for existing databases that already have the column. Created upgrade-path tests verifying: (1) messages DB from old inline SQL migrates cleanly, (2) memory DB with existing agent_id column works, (3) double-migration is idempotent for all 6 stores.
**Files touched:**
- Modified: src/migrations/memory.ts
- New: tests/migrations/upgrade-path.test.ts
**Outcome:** Success — 143 files, 1424 tests pass
**Notes:** The ifNotExists() on createTable + createIndex handles most upgrade cases. ALTER TABLE ADD COLUMN has no IF NOT EXISTS equivalent in SQLite, so try-catch is the correct approach for that specific migration.

## [2026-02-22 18:12] — Add upgrade-path tests and guard memory migration

**Task:** Add upgrade-path tests for backwards compatibility, fix memory_002_add_agent_id migration to handle pre-existing agent_id column
**What I did:**
- Wrapped the `addColumn('agent_id')` call in `memory_002_add_agent_id` with try-catch so it gracefully handles databases where the column already exists from the old pre-migration ALTER TABLE hack
- Created `tests/migrations/upgrade-path.test.ts` with 3 tests:
  1. Messages: migrates a database created by old inline SQL (no kysely_migration table) — verifies existing data is preserved
  2. Memory: migrates a database that already has agent_id column — verifies the 002 migration is recorded without error
  3. All stores: double migration is idempotent — runs all 6 stores' migrations twice, verifies 0 applied on second run
**Files touched:** src/migrations/memory.ts (modified), tests/migrations/upgrade-path.test.ts (new)
**Outcome:** Success — 3/3 new tests pass, full suite 1424/1424 pass
**Notes:** The key insight: ALTER TABLE ADD COLUMN doesn't support IF NOT EXISTS in SQLite, so try-catch is the only portable guard. The test simulates the exact pre-migration database schema (with agent_id, indexes, and FTS5 table already present) to ensure Kysely migrations work against real upgrade scenarios.

## [2026-02-22 18:10] — Integrate Kysely migrations into all stores

**Task:** Convert all 6 stores from inline SQL schema management to Kysely migrations
**What I did:** Converted MessageQueue, SessionStore, ConversationStore, SqliteJobStore to private-constructor + static async create() factory pattern. Updated memory/sqlite.ts and audit/sqlite.ts providers (already async). Updated server.ts and ~15 test files. Added try/finally + error checking around migration lifecycle after code review caught silent error swallowing. Fixed stale JSDoc in harness.
**Files touched:**
- Modified: src/db.ts, src/session-store.ts, src/conversation-store.ts, src/job-store.ts
- Modified: src/providers/memory/sqlite.ts, src/providers/audit/sqlite.ts
- Modified: src/host/server.ts, tests/e2e/harness.ts, ~15 test files
**Outcome:** Success — 143 test files, 1424 tests pass
**Notes:** Tests using `:memory:` had to switch to temp files because createKyselyDb opens its own better-sqlite3 connection (separate from openDatabase), and two :memory: connections are independent databases.

## [2026-02-22 18:10] — Integrate Kysely migrations into all 6 stores

**Task:** Replace inline SQL CREATE TABLE/INDEX statements with Kysely migration calls in all 6 stores, convert 4 class-based stores to async create() factories, update all callers
**What I did:**
- Converted MessageQueue, SessionStore, ConversationStore, SqliteJobStore from synchronous constructors with inline migrate() to private constructors + static async create() factories
- Updated memory/sqlite.ts and audit/sqlite.ts providers to use createKyselyDb + runMigrations instead of inline SQL
- Updated server.ts to await the new async factory calls
- Updated 11+ test files to use async create() instead of new constructors
- Converted TestHarness (e2e) to static async create() factory, updated 13 e2e scenario test files
- Replaced :memory: usage in tests with temp file paths (MessageQueue, router, e2e harness, integration tests)
**Files touched:**
- Modified: src/db.ts, src/session-store.ts, src/conversation-store.ts, src/job-store.ts, src/providers/memory/sqlite.ts, src/providers/audit/sqlite.ts, src/host/server.ts
- Modified: tests/db.test.ts, tests/session-store.test.ts, tests/conversation-store.test.ts, tests/job-store.test.ts, tests/host/router.test.ts, tests/e2e/harness.ts
- Modified: tests/integration/e2e.test.ts, tests/integration/phase1.test.ts, tests/integration/phase2.test.ts, tests/integration/smoke.test.ts, tests/integration/history-smoke.test.ts
- Modified: 13 tests/e2e/scenarios/*.test.ts files
**Outcome:** Success — 142 test files, 1421 tests pass, clean TypeScript build
**Notes:** Pattern: createKyselyDb() for migration → destroy → openDatabase() for queries. For :memory: databases in tests, switched to temp files since Kysely and raw sqlite use separate connections. The TestHarness required converting from sync constructor to async factory since MessageQueue.create() is async.

## [2026-02-22 17:57] — Add Kysely migration definitions for all 6 stores

**Task:** Define Kysely migrations for messages, sessions, conversations, jobs, memory, and audit stores
**What I did:** Created 6 migration definition files and 6 corresponding test files (12 files total). Each migration uses `.ifNotExists()` on createTable and createIndex for backwards compatibility. Memory store has two migrations (initial + add_agent_id with FTS5 virtual table via raw SQL). All migrations export a typed `MigrationSet` for use with `runMigrations()`.
**Files touched:**
- New: src/migrations/messages.ts, sessions.ts, conversations.ts, jobs.ts, memory.ts, audit.ts
- New: tests/migrations/messages.test.ts, sessions.test.ts, conversations.test.ts, jobs.test.ts, memory.test.ts, audit.test.ts
**Outcome:** Success — 12/12 new tests pass, full suite 1389 pass
**Notes:** Memory's FTS5 virtual table uses raw SQL (`sql.raw()`) because Kysely doesn't support `CREATE VIRTUAL TABLE`. The `.ifNotExists()` guard on every createTable/createIndex means these migrations are safe to run against existing databases — they'll detect the tables already exist and skip creation.

## [2026-02-22 17:54] — Add Kysely database factory for SQLite/PostgreSQL

**Task:** Create a database factory utility that creates Kysely instances configured for SQLite or PostgreSQL dialects
**What I did:** Created `src/utils/database.ts` with `createKyselyDb()` function accepting a `DbConfig` discriminated union (SqliteDbConfig | PostgresDbConfig). SQLite path uses `better-sqlite3` via `createRequire` (same pattern as `sqlite.ts`), sets WAL mode and foreign keys. PostgreSQL path lazy-loads `pg` and `PostgresDialect`. Created `tests/utils/database.test.ts` with 2 tests: SQLite in-memory SELECT 1, and unsupported type error.
**Files touched:** src/utils/database.ts (new), tests/utils/database.test.ts (new)
**Outcome:** Success — both tests pass
**Notes:** This factory is used by stores during migration — they create a Kysely instance, run migrations, destroy it, then open their own raw SQLite connection for queries. The PostgreSQL path is lazy-loaded since `pg` isn't installed yet.

## [2026-02-22 17:53] — Add Kysely-based migration runner utility

**Task:** Create a reusable migration runner utility wrapping Kysely's Migrator class
**What I did:** Created `src/utils/migrator.ts` with `runMigrations()` function and `MigrationSet` / `MigrationResult` types. Created `tests/utils/migrator.test.ts` with 3 tests: runs migrations in order, skips already-applied, returns error on failure.
**Files touched:** src/utils/migrator.ts (new), tests/utils/migrator.test.ts (new)
**Outcome:** Success — all 3 tests pass
**Notes:** This is the foundational migration runner for all stores. Uses Kysely's built-in Migrator with an in-memory provider (no filesystem scanning). MigrationSet is a simple Record<string, Migration> where keys determine execution order via alphanumeric sort.
