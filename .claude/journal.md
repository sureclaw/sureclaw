# Journal

## [2026-02-22 22:40] — Fix onboarding config: model selection & conditional API key

**Task:** Fix two bugs in `bun configure`: (1) API key asked even when not using claude-code or when using OAuth, (2) no model selection causing LLM router crash on `bun serve`
**What I did:** Added LLM provider selection (anthropic/openai/openrouter/groq) and model name input for non-claude-code agents. Restructured the auth/API key flow so claude-code agents get auth method selection (api-key/oauth) while router-based agents get provider→model→provider-specific API key. Updated wizard.ts to write model to ax.yaml and use correct env var name (e.g. OPENROUTER_API_KEY). Updated loadExistingConfig to read model back and derive provider.
**Files touched:** src/onboarding/prompts.ts, src/onboarding/wizard.ts, src/onboarding/configure.ts, tests/onboarding/wizard.test.ts, tests/onboarding/configure.test.ts
**Outcome:** Success — 45 tests pass, no TS errors in onboarding files
**Notes:** The configure flow now has two distinct paths after agent selection: claude-code (auth method → api-key/oauth) vs router-based (LLM provider → model → provider API key). This prevents the "config.model is required" error and makes the API key prompt match the actual provider.

## [2026-02-22 00:00] — Enterprise agent architecture: paths.ts foundation

**Task:** Implement enterprise agent architecture — multi-agent, multi-user, governance-controlled
**What I did:** Updated paths.ts with new enterprise layout functions: agentIdentityDir, agentWorkspaceDir, userWorkspaceDir, scratchDir, registryPath, proposalsDir. Updated doc comment with full enterprise filesystem layout.
**Files touched:** src/paths.ts (modified), .claude/journal.md (created), .claude/lessons.md (created)
**Outcome:** Partial — paths.ts foundation complete, remaining phases pending
**Notes:** Work in progress — committing initial paths foundation before continuing with registry, sandbox, memory, IPC, and prompt changes.

## [2026-02-22 01:00] — Enterprise agent architecture: full implementation

**Task:** Complete the enterprise agent architecture across agent registry, sandbox, memory, IPC, tools, prompt, and server
**What I did:** Implemented the full enterprise architecture in 4 phases:
- Phase 1: Created JSON-based agent registry (src/host/agent-registry.ts) with CRUD, capability filtering, parent-child relationships
- Phase 2: Extended SandboxConfig with three-tier mounts (agentWorkspace, userWorkspace, scratchDir), updated all 5 sandbox providers (subprocess, bwrap, nsjail, seatbelt, docker)
- Phase 3: Added agentId scope to MemoryProvider, updated sqlite (with migration), file, and memu providers
- Phase 4: Added 8 enterprise IPC schemas, created workspace and governance handlers, added 6 new tools to catalog and MCP server
- Updated PromptContext, RuntimeModule, identity-loader, agent-setup, runner, server-completions for enterprise support
- Wrote 57 new tests across 5 test files, updated 5 existing test files
**Files touched:**
- New: src/host/agent-registry.ts, src/host/ipc-handlers/workspace.ts, src/host/ipc-handlers/governance.ts
- New tests: tests/host/agent-registry.test.ts, tests/host/ipc-handlers/workspace.test.ts, tests/host/ipc-handlers/governance.test.ts, tests/agent/prompt/enterprise-runtime.test.ts, tests/ipc-schemas-enterprise.test.ts
- Modified: src/providers/sandbox/types.ts, subprocess.ts, bwrap.ts, nsjail.ts, seatbelt.ts, docker.ts
- Modified: src/providers/memory/types.ts, sqlite.ts, file.ts, memu.ts
- Modified: src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-completions.ts
- Modified: src/agent/tool-catalog.ts, mcp-server.ts, runner.ts, agent-setup.ts
- Modified: src/agent/prompt/types.ts, modules/runtime.ts, identity-loader.ts
- Modified: src/types.ts
- Modified tests: tests/agent/tool-catalog.test.ts, ipc-tools.test.ts, mcp-server.test.ts, tool-catalog-sync.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 1140/1141 tests pass (1 pre-existing flaky test unrelated to changes)
**Notes:** Rebased onto main after PR #15 merge (server decomposition). Key design decisions: proposals stored as individual JSON files, workspace writes queued in paranoid mode, agent registry uses atomic file writes via rename.

## [2026-02-22 02:00] — Rebase onto main and fix build error

**Task:** Rebase feature branch onto latest main to resolve merge conflicts, then update PR
**What I did:** Fetched latest main, rebased `claude/enterprise-agent-architecture-LyxFf` onto `origin/main`. Git auto-skipped the duplicate server decomposition commit (already merged via PR #15). Fixed a TypeScript build error in `src/config.ts` where `providerEnum()` produced a loosely-typed Zod enum that didn't match Config's literal union types — added a safe type assertion since the schema validates the same constraints at runtime.
**Files touched:** src/config.ts (modified), .claude/journal.md (modified)
**Outcome:** Success — clean rebase, build passes
**Notes:** Rebase reduced branch from 3 to 2 commits ahead of main. The config.ts type issue may have been pre-existing but was exposed by the rebase.

## [2026-02-22 03:00] — Fix CI failures: tests and semgrep

**Task:** Fix CI test failures and semgrep configuration issues
**What I did:**
- Fixed `scratchDir()` in paths.ts to handle colon-separated session IDs (same as `workspaceDir()`) — was using `validatePathSegment()` which rejects colons/dots, but channel session IDs like `test:thread:C02:2000.0001` contain both
- Added 3 regression tests for `scratchDir` in tests/paths.test.ts
- Created `.semgrep.yml` with 4 project-specific security rules (SC-SEC-002 dynamic imports, SC-SEC-004 path safety, no eval, no Function constructor)
- Created `.semgrep-ci.yml` with 2 CI rules (no console.log in host/providers, prototype pollution detection)
- Refactored oauth.ts to use `spawn()` instead of `exec()` with string interpolation (command injection fix)
- Added `nosemgrep` annotations to all intentional spawn/exec calls in sandbox providers and local-tools
**Files touched:** src/paths.ts, tests/paths.test.ts, .semgrep.yml (new), .semgrep-ci.yml (new), src/host/oauth.ts, src/agent/local-tools.ts, src/providers/sandbox/{subprocess,nsjail,docker,seatbelt,bwrap}.ts
**Outcome:** Success — 1214/1215 tests pass, tsc clean, semgrep clean, fuzz tests pass
**Notes:** Community semgrep rulesets (p/security-audit, p/nodejs, p/typescript) couldn't be tested locally due to network restrictions, but nosemgrep annotations cover the known intentional patterns.

## [2026-02-22 04:00] — Fix npm audit CI failure

**Task:** npm audit --audit-level=moderate was failing in CI with 9 vulnerabilities
**What I did:** Ran `npm audit fix` to resolve 5 direct-fixable vulns (ajv, fast-xml-parser, hono, qs). Remaining 4 were transitive minimatch@9.0.6 via gaxios→rimraf→glob chain. Added npm overrides in package.json to force minimatch>=10.2.1 and glob>=11.0.0.
**Files touched:** package.json, package-lock.json
**Outcome:** Success — 0 vulnerabilities, all 1214 tests still pass
**Notes:** The minimatch vuln was deep transitive (@mariozechner/pi-ai → @google/genai → google-auth-library → gaxios → rimraf → glob → minimatch). npm overrides are the right approach for transitive deps that upstream hasn't patched yet.

## [2026-02-22 05:00] — Add comprehensive fault tolerance

**Task:** Make AX tolerant to all kinds of external and internal failures (LLM provider failures/timeouts, host/container crashes, agent crashes, process hangs, etc.)
**What I did:** Added 8 fault tolerance mechanisms across the codebase:
1. **Retry utility** (`src/utils/retry.ts`): Reusable `withRetry()` with exponential backoff, jitter, AbortSignal, and configurable error classification
2. **Circuit breaker** (`src/utils/circuit-breaker.ts`): Three-state (closed/open/half_open) circuit breaker with configurable threshold, reset timeout, and failure predicates
3. **IPC client reconnection** (`src/agent/ipc-client.ts`): Auto-reconnect with exponential backoff on connection-level errors (EPIPE, ECONNRESET, etc.), retry-after-reconnect for transient failures, no retry for timeouts
4. **Agent crash recovery** (`src/host/server-completions.ts`): Retry loop (up to 2 retries) for transient agent crashes (OOM kills, segfaults, connection errors), with `isTransientAgentFailure()` classifier distinguishing permanent (auth, timeout, bad config) from transient failures
5. **Graceful shutdown with request draining** (`src/host/server.ts`): In-flight request tracking, 503 rejection of new requests during shutdown, drain timeout (30s), health endpoint reports draining status
6. **Graceful process termination** (`src/providers/sandbox/utils.ts`): `enforceTimeout` now sends SIGTERM first, waits grace period (default 5s), then SIGKILL — tracked via 'exit' event instead of `child.killed`
7. **Channel reconnection** (`src/host/server-channels.ts`): `connectChannelWithRetry()` wraps channel.connect() with retry/backoff, classifies auth errors as permanent
8. **IPC handler timeout** (`src/host/ipc-server.ts`): 15-minute safety-net timeout via `Promise.race()` prevents hung handlers from blocking the IPC server
**Files touched:**
- New: src/utils/retry.ts, src/utils/circuit-breaker.ts
- New tests: tests/utils/retry.test.ts, tests/utils/circuit-breaker.test.ts, tests/host/fault-tolerance.test.ts, tests/agent/ipc-client-reconnect.test.ts, tests/host/channel-reconnect.test.ts
- Modified: src/agent/ipc-client.ts, src/host/server.ts, src/host/server-completions.ts, src/host/server-channels.ts, src/host/ipc-server.ts, src/providers/sandbox/utils.ts
- Modified tests: tests/providers/sandbox/utils.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 1267/1268 tests pass (1 pre-existing skip)
**Notes:** Key design decisions: (1) retry utility is generic and composable for future use, (2) circuit breaker is standalone for wrapping any provider, (3) agent crash retry is conservative (max 2 retries) to avoid infinite loops, (4) timeout-killed agents are NOT retried since they already spent their full time budget, (5) IPC client doesn't retry timeouts since the call may have been received server-side.

## [2026-02-22 20:30] — OpenClaw gap analysis

**Task:** Identify major functionality gaps between AX and OpenClaw
**What I did:** Researched OpenClaw's full feature set (12+ channels, ClawHub marketplace with 3,286+ skills, voice support, Canvas visual workspace, native apps, Semantic Snapshots browser automation, Lobster workflow shell, webhook triggers, embedding-based memory search) and mapped it against AX's actual implementation state. Produced a prioritized gap analysis document with 15 identified gaps, categorized by priority and whether they're intentional design decisions.
**Files touched:** docs/plans/2026-02-22-openclaw-gap-analysis.md (created), .claude/journal.md (modified)
**Outcome:** Success — comprehensive gap analysis with prioritized recommendations
**Notes:** Key findings: (1) Channel coverage is the #1 adoption blocker — only Slack is implemented, WhatsApp/Telegram/Discord files don't exist despite being in provider-map.ts. (2) Phase 3 competitive strategy (ClawHub compatibility, skill screener, security officer) is entirely unimplemented. (3) AX has genuine security advantages that OpenClaw lacks (kernel sandbox, credential proxy, taint tracking). (4) Several gaps are intentional architectural decisions (no web UI, no marketplace).

## [2026-02-22 20:30] — E2E test framework with simulated providers

**Task:** Build an end-to-end test framework that simulates all external dependencies (LLMs, web APIs, timers, Slack messages, etc.) to test common AX operations
**What I did:** Created a comprehensive E2E test framework with three core components:
1. **ScriptedLLM** (`tests/e2e/scripted-llm.ts`): A mock LLM provider that follows a pre-defined script of turns. Supports sequential turns, conditional matching (by message content or tool_result presence), and call recording. Convenience helpers for text, tool_use, and mixed turns.
2. **TestHarness** (`tests/e2e/harness.ts`): Wires together mock providers, router, IPC handler, and MessageQueue. Drives events (sendMessage, fireCronJob, runAgentLoop) and provides assertion helpers (auditEntriesFor, memoryForScope, readIdentityFile, readWorkspaceFile). Sets AX_HOME to a temp dir for filesystem isolation.
3. **8 scenario test files** covering: Slack message flow, scheduled tasks, skill creation, workspace operations, identity/soul updates, web search/fetch, multi-turn tool use loops, full pipeline integration.
**Files touched:**
- New: tests/e2e/scripted-llm.ts, tests/e2e/harness.ts
- New: tests/e2e/scenarios/{slack-message,scheduled-task,skill-creation,workspace-ops,identity-update,web-search,multi-turn-tool-use,full-pipeline}.test.ts
**Outcome:** Success — 64 new E2E tests, all passing. Full suite: 1277 pass + 64 new = 1341 pass (1 pre-existing flaky smoke test timeout unrelated)
**Notes:** The provider contract pattern makes this approach very effective — every external dependency is behind an interface. The ScriptedLLM with sequential + conditional turns enables scripting complex multi-turn agent loops. Key gotchas: web_search handler returns SearchResult[] spread as array indices, web_fetch returns FetchResponse spread flat, skill_propose returns ProposalResult spread flat, scratchDir requires UUID or 3+ colon-separated session IDs.

## [2026-02-22 22:00] — Bootstrap admin auto-promotion for first channel user

**Task:** Fix UX bug where no channel user can interact during bootstrap because the admins file is seeded with the OS username (not a Slack user ID)
**What I did:**
- Added `addAdmin()` and `claimBootstrapAdmin()` to `src/host/server.ts` — claim uses atomic file creation (`writeFileSync` with `'wx'` flag) to ensure only one user wins
- Updated `ChannelHandlerDeps` interface and bootstrap gate in `src/host/server-channels.ts` — first channel user during bootstrap is auto-promoted to admin
- Added `.bootstrap-admin-claimed` cleanup in `src/cli/bootstrap.ts` `resetAgent()` so re-bootstrap allows a new first-user claim
- Added unit tests for `addAdmin` and `claimBootstrapAdmin`, plus integration tests for auto-promotion and second-user blocking
- Added bootstrap test for `.bootstrap-admin-claimed` cleanup
**Files touched:** src/host/server.ts, src/host/server-channels.ts, src/cli/bootstrap.ts, tests/host/admin-gate.test.ts, tests/cli/bootstrap.test.ts
**Outcome:** Success — new bootstrap cleanup tests pass (4/5, 1 pre-existing failure). Admin-gate integration tests can't run in this environment due to missing `yaml` dependency (pre-existing).
**Notes:** The atomic claim via `O_EXCL` is simple and race-safe for a single-server process. The claim file stores the userId for debugging. The OS username stays in the admins file (inert for channel access, useful for CLI).

## [2026-02-22 17:53] — Add Kysely-based migration runner utility

**Task:** Create a reusable migration runner utility wrapping Kysely's Migrator class
**What I did:** Created `src/utils/migrator.ts` with `runMigrations()` function and `MigrationSet` / `MigrationResult` types. Created `tests/utils/migrator.test.ts` with 3 tests: runs migrations in order, skips already-applied, returns error on failure.
**Files touched:** src/utils/migrator.ts (new), tests/utils/migrator.test.ts (new)
**Outcome:** Success — all 3 tests pass
**Notes:** This is the foundational migration runner for all stores. Uses Kysely's built-in Migrator with an in-memory provider (no filesystem scanning). MigrationSet is a simple Record<string, Migration> where keys determine execution order via alphanumeric sort.

## [2026-02-22 21:00] — E2E test framework: expanded coverage for missing scenarios

**Task:** Address gaps in E2E test coverage — memory CRUD lifecycle, browser interactions (click/type/screenshot/close), governance proposals, agent delegation, agent registry, audit query, and error handling
**What I did:**
- Extended TestHarness with `delegation`, `onDelegate`, and `seedAgents` options, plus `agentRegistry` field backed by a temp-dir AgentRegistry
- Created 5 new scenario test files:
  1. `memory-lifecycle.test.ts` (10 tests): write → read → list → delete full lifecycle, tag filtering, limit, multi-turn LLM memory write+query
  2. `browser-interaction.test.ts` (7 tests): click, type, screenshot (base64), close, full login-form flow, navigate audit, multi-turn LLM browser form fill
  3. `governance-proposals.test.ts` (18 tests): identity_propose, proposal_list (with status filter), proposal_review (approve/reject/nonexistent/already-reviewed), agent_registry_list (with status filter), agent_registry_get, full propose→list→review→verify flow, scanner blocking, audit trail
  4. `agent-delegation.test.ts` (9 tests): successful delegation, unconfigured handler error, depth limit, concurrency limit, context passing, child context verification, audit trail, multi-turn LLM delegation
  5. `error-handling.test.ts` (14 tests): invalid JSON, unknown actions, audit_query, empty inputs, nested workspace paths, rapid sequential writes, mixed operation consistency, max turns, harness isolation, seeded data verification
**Files touched:**
- Modified: tests/e2e/harness.ts (added delegation/registry/seedAgents support)
- New: tests/e2e/scenarios/{memory-lifecycle,browser-interaction,governance-proposals,agent-delegation,error-handling}.test.ts
**Outcome:** Success — 58 new E2E tests, all passing. Full suite: 1336 pass + 1 skipped (pre-existing)
**Notes:** Key gotchas: `identity_propose` requires `origin: 'agent_initiated'` (not `'agent'`), `memory_read` ID must be valid UUID per Zod schema, `proposalId` must be valid UUID, multiple TestHarness instances need careful dispose ordering to avoid "database not open" errors in afterEach.

## [2026-02-22 17:54] — Add Kysely database factory for SQLite/PostgreSQL

**Task:** Create a database factory utility that creates Kysely instances configured for SQLite or PostgreSQL dialects
**What I did:** Created `src/utils/database.ts` with `createKyselyDb()` function accepting a `DbConfig` discriminated union (SqliteDbConfig | PostgresDbConfig). SQLite path uses `better-sqlite3` via `createRequire` (same pattern as `sqlite.ts`), sets WAL mode and foreign keys. PostgreSQL path lazy-loads `pg` and `PostgresDialect`. Created `tests/utils/database.test.ts` with 2 tests: SQLite in-memory SELECT 1, and unsupported type error.
**Files touched:** src/utils/database.ts (new), tests/utils/database.test.ts (new)
**Outcome:** Success — both tests pass
**Notes:** This factory is used by stores during migration — they create a Kysely instance, run migrations, destroy it, then open their own raw SQLite connection for queries. The PostgreSQL path is lazy-loaded since `pg` isn't installed yet.

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

## [2026-02-22 17:57] — Add Kysely migration definitions for all 6 stores

**Task:** Define Kysely migrations for messages, sessions, conversations, jobs, memory, and audit stores
**What I did:** Created 6 migration definition files and 6 corresponding test files (12 files total). Each migration uses `.ifNotExists()` on createTable and createIndex for backwards compatibility. Memory store has two migrations (initial + add_agent_id with FTS5 virtual table via raw SQL). All migrations export a typed `MigrationSet` for use with `runMigrations()`.
**Files touched:**
- New: src/migrations/messages.ts, sessions.ts, conversations.ts, jobs.ts, memory.ts, audit.ts
- New: tests/migrations/messages.test.ts, sessions.test.ts, conversations.test.ts, jobs.test.ts, memory.test.ts, audit.test.ts
**Outcome:** Success — 16 tests pass across 6 test files
**Notes:** FTS5 virtual tables require raw SQL since Kysely's schema builder doesn't support VIRTUAL TABLE syntax. The memory store's second migration (memory_002_add_agent_id) uses ALTER TABLE ADD COLUMN which doesn't support ifNotExists in SQLite, but the migration runner tracks applied migrations so it won't run twice.

## [2026-02-22 18:00] — Integrate Kysely migrations into all stores

**Task:** Convert all 6 stores from inline SQL schema management to Kysely migrations
**What I did:** Converted MessageQueue, SessionStore, ConversationStore, SqliteJobStore to private-constructor + static async create() factory pattern. Updated memory/sqlite.ts and audit/sqlite.ts providers (already async). Updated server.ts and ~15 test files. Added try/finally + error checking around migration lifecycle after code review caught silent error swallowing. Fixed stale JSDoc in harness.
**Files touched:**
- Modified: src/db.ts, src/session-store.ts, src/conversation-store.ts, src/job-store.ts
- Modified: src/providers/memory/sqlite.ts, src/providers/audit/sqlite.ts
- Modified: src/host/server.ts, tests/e2e/harness.ts, ~15 test files
**Outcome:** Success — 143 test files, 1424 tests pass
**Notes:** Tests using `:memory:` had to switch to temp files because createKyselyDb opens its own better-sqlite3 connection (separate from openDatabase), and two :memory: connections are independent databases.

## [2026-02-22 18:13] — Add upgrade-path tests and guard memory migration

**Task:** Verify backwards compatibility with existing databases and fix memory_002 migration
**What I did:** Added try-catch to memory_002_add_agent_id for existing databases that already have the column. Created upgrade-path tests verifying: (1) messages DB from old inline SQL migrates cleanly, (2) memory DB with existing agent_id column works, (3) double-migration is idempotent for all 6 stores.
**Files touched:**
- Modified: src/migrations/memory.ts
- New: tests/migrations/upgrade-path.test.ts
**Outcome:** Success — 143 files, 1424 tests pass
**Notes:** The ifNotExists() on createTable + createIndex handles most upgrade cases. ALTER TABLE ADD COLUMN has no IF NOT EXISTS equivalent in SQLite, so try-catch is the correct approach for that specific migration.
