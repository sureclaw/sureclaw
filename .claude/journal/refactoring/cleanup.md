# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment, dependency updates.

## [2026-03-24 12:55] — Fix CI: bump pi-ai to match pi-agent-core/pi-coding-agent

**Task:** Fix failing GitHub Actions test job on PR #117 (dependabot production dep bump)
**What I did:** The dependabot PR bumped pi-agent-core and pi-coding-agent to ^0.61.1 but left pi-ai at ^0.58.1. The newer packages depend on pi-ai@^0.61.1 internally, creating nested duplicate copies with incompatible AssistantMessageEventStream types (private property 'isComplete' mismatch). Bumped pi-ai to ^0.61.1 in package.json to deduplicate.
**Files touched:** package.json, package-lock.json
**Outcome:** Success — tsc --noEmit passes, all 225 test files (2554 tests) pass, fuzz tests pass
**Notes:** Dependabot doesn't always catch transitive peer alignment. When pi-* packages are bumped together, pi-ai must be bumped to the same version family.

## [2026-03-20 08:40] — Phase 2: createRequestHandler() shared route factory

**Task:** Extract remaining duplicated HTTP route dispatch from server-local.ts and server-k8s.ts into a shared createRequestHandler() factory
**What I did:** (1) Added createRequestHandler() factory to server-request-handlers.ts with all shared routes (CORS, health, models, completions, files, SSE events, webhooks, credentials, OAuth, admin, root redirect, 404) plus hooks for extraRoutes and graceful drain. (2) Rewrote server-local.ts to use createRequestHandler() -- replaced ~160-line inline handleRequest. (3) Rewrote server-k8s.ts to use createRequestHandler() with handleInternalRoutes for /internal/* routes. (4) Removed inline NATS SSE handler from k8s (NATS eventbus provider already bridges events to EventBus). (5) Added graceful drain tracking to k8s shutdown. (6) Cleaned up unused imports.
**Files touched:** src/host/server-request-handlers.ts, src/host/server-local.ts, src/host/server-k8s.ts
**Outcome:** Success — all 215 test files pass (2473 tests), build clean. server-local.ts dropped 188 lines, server-k8s.ts dropped 90 net lines. Both servers now gain file routes, OAuth, credentials, bootstrap gate, and root redirect from the shared handler.
**Notes:** Key discovery: NATS eventbus provider (src/providers/eventbus/nats.ts) already implements the full EventBus interface by subscribing to NATS subjects and dispatching to listeners. The inline NATS SSE handler in server-k8s.ts was redundant with the shared handleEventsSSE that uses EventBus.subscribe/subscribeRequest. Server-k8s.ts was previously missing: file upload/download, OAuth callback, bootstrap gate pre-flight, root->admin redirect, and graceful drain.

## [2026-03-20 08:05] — Rename server.ts to server-local.ts, host-process.ts to server-k8s.ts

**Task:** Rename server entry points to reflect their semantic role (local vs k8s) and update all imports across the codebase
**What I did:** Used `git mv` for both renames. Updated imports in 8 source/test files (cli/index.ts, cli/reload.ts, 4 test files, 2 test harnesses). Updated Dockerfile CMD, Helm chart commands (values.yaml, kind-dev-values.yaml), k8s archive YAML. Fixed 3 test files that read source by filename (sandbox-isolation, workspace-provision-fixes, gcs-remote-transport). Updated 5 skill files (ax-host, ax-debug, ax-provider-credentials, ax-provider-sandbox, acceptance-test). Updated internal comments in server-k8s.ts and server-init.ts.
**Files touched:** src/host/server.ts (renamed), src/host/host-process.ts (renamed), src/cli/index.ts, src/cli/reload.ts, tests/host/server.test.ts, tests/host/server-multimodal.test.ts, tests/host/server-history.test.ts, tests/host/admin-gate.test.ts, tests/e2e/server-harness.ts, tests/providers/sandbox/run-nats-local.ts, tests/sandbox-isolation.test.ts, tests/agent/workspace-provision-fixes.test.ts, tests/providers/workspace/gcs-remote-transport.test.ts, container/agent/Dockerfile, charts/ax/values.yaml, charts/ax/kind-dev-values.yaml, k8s/archive/host.yaml, src/host/server-init.ts, .claude/skills/ax-host/SKILL.md, .claude/skills/ax-debug/SKILL.md, .claude/skills/ax-provider-credentials/SKILL.md, .claude/skills/ax-provider-sandbox/SKILL.md, .claude/skills/acceptance-test/SKILL.md
**Outcome:** Success — `npx tsc --noEmit` clean, all 215 test files pass (2473 tests)
**Notes:** Source-reading tests (sandbox-isolation, gcs-remote-transport, workspace-provision-fixes) reference filenames as string literals to readFileSync, not as imports. These needed manual updates beyond grep for import patterns. Historical acceptance test results/plans/lessons left as-is per append-only policy.

## [2026-03-20 08:00] — Server init extraction: deduplicate server.ts and host-process.ts

**Task:** Extract ~700 lines of duplicated initialization, request handling, and lifecycle code from server.ts and host-process.ts into shared modules
**What I did:** Created 4 new shared modules and rewrote both server.ts and host-process.ts to use them:
- `server-admin-helpers.ts` — pure admin functions (isAdmin, claimBootstrapAdmin, etc.)
- `server-init.ts` — `initHostCore()` shared initialization (storage, routing, IPC, templates, orchestrator)
- `server-request-handlers.ts` — shared HTTP handlers (completions, events SSE, scheduler callback, models)
- `server-webhook-admin.ts` — shared webhook + admin handler factories
**Files touched:** Created: src/host/server-admin-helpers.ts, src/host/server-init.ts, src/host/server-request-handlers.ts, src/host/server-webhook-admin.ts. Modified: src/host/server.ts, src/host/host-process.ts, src/host/server-completions.ts, src/host/ipc-handlers/identity.ts, src/host/ipc-handlers/governance.ts
**Outcome:** Success — all 215 test files pass (2473 tests), build clean. server.ts shrank from ~1250 to ~500 lines, host-process.ts from ~1248 to ~630 lines.
**Notes:** Key pattern: shared `runCompletion` callback lets server.ts pass `processCompletion` directly while host-process.ts wraps with `processCompletionWithNATS`. Legacy migration and USER_BOOTSTRAP filesystem copy kept as server.ts-specific post-init steps. NATS-based SSE events kept in host-process.ts since they use a fundamentally different subscription mechanism.

## [2026-03-13 09:15] — Phase 2: Drop file-based StorageProvider

**Task:** Remove `src/providers/storage/file.ts` and all file-based storage code; make database storage the only option.
**What I did:** (1) Deleted `src/providers/storage/file.ts` and `tests/providers/storage/file.test.ts`. (2) Removed 'file' from storage provider map in `src/host/provider-map.ts`. (3) Changed storage default from 'file' to 'database' and database default from undefined to 'sqlite' in `src/config.ts`. (4) Added legacy file-storage directory warning in `src/providers/storage/database.ts`. (5) Updated `tests/integration/history-smoke.test.ts` to check for SQLite DB file instead of JSONL conversation files. (6) Updated acceptance fixture, README, skill files, and paths.ts comments.
**Files touched:** `src/providers/storage/file.ts` (deleted), `tests/providers/storage/file.test.ts` (deleted), `src/host/provider-map.ts`, `src/config.ts`, `src/providers/storage/database.ts`, `src/paths.ts`, `tests/integration/history-smoke.test.ts`, `tests/acceptance/fixtures/ax.yaml`, `README.md`, `.claude/skills/ax/provider-storage/SKILL.md`, `.claude/skills/ax/config/SKILL.md`
**Outcome:** Success — build passes, all 205 test files pass (2378 tests), zero failures.
**Notes:** StorageProviderName type automatically narrows to just 'database' since it's derived from the provider map. The `database` config field now defaults to 'sqlite' so the storage provider always has a database backend available.

## [2026-03-05 20:44] — Rename memoryfs → cortex

**Task:** Rename the "memoryfs" memory provider to "cortex" across the entire codebase
**What I did:** Renamed directories (src, tests, acceptance), updated all type names (MemoryFSItem→CortexItem, MemoryFSConfig→CortexConfig), provider-map registration, config values in 13 YAML files, source file internals (headers, logger, JSDoc), 21+ test files, 4 skill files, and acceptance README. Used 6 parallel agents for efficiency.
**Files touched:** 50+ files across src/, tests/, charts/, flux/, .claude/skills/, ax.yaml
**Outcome:** Success — build passes, all 2325 tests pass, no remaining memoryfs references in src/ or YAML configs. Only 2 intentionally preserved historical skip-test descriptions in phase2.test.ts.
**Notes:** Historical journal/lessons entries left as-is (append-only policy). Acceptance test plan/results/fixes docs under tests/acceptance/cortex/ still reference old name in historical context.

## [2026-03-05 19:25] — Database layer refactoring (14-task plan)

**Task:** Consolidate 10+ standalone SQLite connections into a shared DatabaseProvider factory
**What I did:** Implemented full 14-task plan: (1) Created DatabaseProvider interface + SQLite/PostgreSQL implementations. (2) Created storage/database and storage/file providers. (3) Created audit/database provider. (4) Ported memoryfs ItemsStore and EmbeddingStore to Kysely. (5) Ported JobStore, FileStore, OrchestrationEventStore to shared DB. (6) Removed legacy sqlite/postgresql providers. (7) Extracted content-serialization utils. (8) Deleted dead code (db.ts, session-store.ts, conversation-store.ts, old migrations). (9) Updated 50+ test files and YAML configs.
**Files touched:** ~80 files created/modified/deleted across src/providers/, src/host/, src/utils/, tests/, charts/
**Outcome:** Success — 202 test files pass (2305 tests), only pre-existing k8s mock failure remains
**Notes:** Union return types (`T | Promise<T>`) needed for interfaces supporting both sync MemoryJobStore and async KyselyJobStore. Provider-local migrations pattern (each consumer runs own migrations against shared Kysely) works well.

## [2026-03-03 21:45] — Fix PR #60: production dependency bumps (7 packages)

**Task:** Fix Dependabot PR #60 that bumps 7 production dependencies including 3 major version bumps (ink 5→6, marked 11→17, react 18→19)
**What I did:** (1) Merged dependabot branch into working branch. (2) Fixed `AuthStorage` constructor change in pi-agent-core 0.55.4 — now uses `AuthStorage.create()` factory method instead of `new AuthStorage()`. (3) Rewrote `src/cli/utils/markdown.ts` renderer for marked v17 API — all methods now use token objects instead of positional args, `this.parser.parseInline(tokens)` for inline rendering, and `list()` must manually iterate items via `this.listitem()` instead of `this.parser.parse(token.items)`. (4) React 18→19 and Ink 5→6 required zero code changes.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/cli/utils/markdown.ts`, `package.json`, `package-lock.json`
**Outcome:** Success — build clean, all 208 test files pass (2298 tests)
**Notes:** The marked v17 `list()` renderer cannot pass `token.items` to `this.parser.parse()` because the parser doesn't recognize `list_item` tokens. Must iterate items manually and call `this.listitem(item)` for each.

## [2026-03-01 15:50] — Clean up stale scratch tier references

**Task:** Remove stale "scratch" tier references from tool catalog, MCP server, and runtime prompt after upstream PR removed the scratch tier from IPC schemas
**What I did:** (1) Reverted `.filter(t => t.name !== 'write')` in pi-session.ts so local `write` tool is available for ephemeral `/scratch` writes. (2) Updated 4 tier description strings in tool-catalog.ts from `"agent", "user", or "scratch"` to `"agent" or "user"`. (3) Updated 1 tier description in mcp-server.ts similarly. (4) Renamed runtime prompt section from "Workspace Tiers" to "Workspace" and added `/scratch` ephemeral working directory description. (5) Updated test assertions to match new heading.
**Files touched:** `src/agent/runners/pi-session.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass
**Notes:** The mcp-server.ts file had a stale reference not mentioned in the original plan. Always grep broadly for stale references when cleaning up removed features.
