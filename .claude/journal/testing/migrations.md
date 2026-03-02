# Testing: Migrations

Kysely migration infrastructure: runner, database factory, store integration, upgrade-path tests.

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
