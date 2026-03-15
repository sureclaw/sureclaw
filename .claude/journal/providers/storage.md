# Storage Provider Journal

## [2026-03-15 15:05] — Fix first-run bootstrap with DocumentStore (GCS) backends

**Task:** Bootstrap never occurs on first run when using GCS/cloud-backed DocumentStore — only SOUL.md appears in the bucket, no BOOTSTRAP ritual. Also SOUL.md was being written to GCS workspace on every request.
**What I did:** (1) Root cause: template files (BOOTSTRAP.md, AGENTS.md, etc.) were seeded to filesystem only, but identity is loaded from DocumentStore for agent prompts. On first run with GCS, DocumentStore was empty. (2) Added DocumentStore seeding alongside filesystem seeding in server.ts and agent-runtime-process.ts. (3) Fixed bootstrap completion in identity.ts to check DocumentStore (not filesystem) for whether both SOUL.md and IDENTITY.md exist. Also cleans up filesystem BOOTSTRAP.md for backward compat. (4) Fixed governance.ts to write approved proposals to DocumentStore too (was filesystem-only) and use DocumentStore-based bootstrap completion. (5) Removed identity/skills workspace write from server-completions.ts — the agent gets identity via stdin payload and can use `identity({ type: "read" })` IPC tool. Writing to GCS-backed workspace on every request created unnecessary cloud I/O. (6) Updated governance tests with mock DocumentStore, updated ipc-server bootstrap tests.
**Files touched:** src/host/server.ts, src/host/agent-runtime-process.ts, src/host/server-completions.ts, src/host/ipc-handlers/identity.ts, src/host/ipc-handlers/governance.ts, tests/host/ipc-server.test.ts, tests/host/ipc-handlers/governance.test.ts
**Outcome:** Success — 2400 tests pass (1 pre-existing macOS symlink failure unrelated)
**Notes:** `isAgentBootstrapMode()` in server.ts still checks filesystem for the HTTP/channel admin bootstrap gate. This is fine because the filesystem BOOTSTRAP.md is also seeded, and it gets cleaned up when bootstrap completes. The DocumentStore is now the authoritative source for bootstrap completion detection in the identity/governance handlers.

## [2026-03-13 09:10] -- Phase 1D: Migrate identity/skills IPC handlers to DocumentStore

**Task:** Update identity_read, identity_write, user_write IPC handlers and readonly skills provider to use DocumentStore instead of filesystem. Last piece of Phase 1 storage simplification.
**What I did:** (1) Rewrote identity.ts handlers to read/write via `documents.get/put/delete('identity', key)` with key scheme `${agentName}/${file}`. Removed all filesystem imports from identity.ts. Removed `agentDir` from IdentityHandlerOptions. (2) Rewrote readonly.ts skills provider to use DocumentStore with `create(config, name?, opts?)` accepting `{ storage }`. (3) Reordered registry.ts to load storage BEFORE skills. (4) Updated ipc-server.ts to stop passing agentDir to identity handler. (5) Fixed 8+ test files to add `storage.documents` mock to mock registries. (6) Updated e2e harness `readIdentityFile()` from sync filesystem to async DocumentStore lookup. (7) Added `await` to all `readIdentityFile` callers in e2e scenario tests.
**Files touched:**
  - Modified: src/host/ipc-handlers/identity.ts, src/providers/skills/readonly.ts, src/host/registry.ts, src/host/ipc-server.ts, src/providers/skills/git.ts
  - Modified (tests): tests/host/ipc-server.test.ts, tests/host/ipc-handlers/identity.test.ts, tests/host/ipc-handlers/skills-install.test.ts, tests/host/ipc-delegation.test.ts, tests/host/delegation-hardening.test.ts, tests/integration/cross-component.test.ts, tests/integration/e2e.test.ts, tests/integration/phase2.test.ts, tests/providers/skills/readonly.test.ts, tests/e2e/harness.ts, tests/e2e/scenarios/identity-update.test.ts, tests/e2e/scenarios/full-pipeline.test.ts, tests/e2e/scenarios/governance-proposals.test.ts
**Outcome:** Success. All 204 test files pass (2370 tests), TypeScript builds cleanly.
**Notes:** `isAgentBootstrapMode` and `isAdmin` remain filesystem-based — they are shared by server.ts, server-channels.ts, governance.ts, and identity.ts. Governance handler still writes identity files to filesystem on proposal approval. Both of these will be addressed in a future phase. The bootstrap completion test requires both SOUL.md and IDENTITY.md to exist on filesystem for `isAgentBootstrapMode` to return false.

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
