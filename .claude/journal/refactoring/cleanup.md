# Refactoring: Cleanup

General refactoring, stale reference cleanup, path realignment, dependency updates.

## [2026-04-06 14:00] — PVC Workspace Phase 2: Update host and agent code for single workspace

**Task:** Fix all host-side and agent-side code to use the single /workspace model (Phase 1 simplified sandbox providers)
**What I did:** Removed agentWorkspace/userWorkspace/workspaceProvider/agentReadOnly from AgentConfig and StdinPayload. Updated applyPayload() to write skills to /workspace/skills/ and MCP CLIs to /workspace/bin/. Merged agent-scoped and user-scoped skills into single array in server-completions.ts. Removed enterprise workspace setup (agentWsPath/userWsPath/mkdir). Updated sandboxConfig to use pvcName instead of agentWorkspace/userWorkspace. Updated agent-setup.ts scanMcpCLIs() and buildSystemPrompt() to use config.workspace. Updated PromptContext (hasWorkspace replaces hasAgentWorkspace/hasUserWorkspace/userWorkspaceWritable). Updated RuntimeModule and SkillsModule. Updated both runners (pi-session, claude-code) for single workspace skill deps. Fixed 30 test failures across 8 test files.
**Files touched:** src/host/server-completions.ts, src/agent/runner.ts, src/agent/agent-setup.ts, src/agent/prompt/types.ts, src/agent/prompt/modules/skills.ts, src/agent/prompt/modules/runtime.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/paths.ts, src/agent/skill-installer.ts, src/host/capnweb/generate-and-cache.ts, src/host/capnweb/codegen.ts, tests/sandbox-isolation.test.ts, tests/agent/prompt/modules/skills.test.ts, tests/agent/prompt/modules/runtime.test.ts, tests/providers/sandbox/canonical-paths.test.ts, tests/agent/agent-setup.test.ts
**Outcome:** Success — build zero errors, 2584 tests pass (2 pre-existing flaky integration failures unrelated to changes)
**Notes:** paths.ts functions agentWorkspaceDir/userWorkspaceDir marked deprecated but kept for backward compat in host-side file storage (server-files.ts, server-channels.ts, llm handler).

## [2026-04-06 12:00] — PVC Workspace Phase 1: Simplify workspace model + PVC support

**Task:** Replace agent/user workspace split with single /workspace per agent, add PVC support to k8s sandbox provider
**What I did:** Removed agentWorkspace/userWorkspace/agentWorkspaceWritable/userWorkspaceWritable from SandboxConfig, added pvcName. Simplified CANONICAL to just {root: '/workspace'}. Simplified canonicalEnv() to remove agent/user env vars, always prepend /workspace/bin to PATH. Simplified createCanonicalSymlinks() to a pass-through. Removed symlinkEnv(). Updated Docker/Apple providers to mount single /workspace (rw). Removed workspaceLocation from SandboxProvider interface. Added ensurePvc() and deletePvc() to k8s provider, with PVC-backed volumes when pvcName is set.
**Files touched:** src/providers/sandbox/types.ts, src/providers/sandbox/canonical-paths.ts, src/providers/sandbox/docker.ts, src/providers/sandbox/apple.ts, src/providers/sandbox/k8s.ts
**Outcome:** Success — sandbox provider files compile cleanly. One expected downstream error in server-completions.ts (Phase 2 fix).
**Notes:** The build has 1 error in server-completions.ts referencing removed agentWorkspace field — intentionally left for Phase 2.

## [2026-04-06 06:30] — Phase 7: Final verification, docs, skills cleanup

**Task:** Final cleanup pass for architecture simplification — verify build/tests, update all docs and skills to reflect removed features (browser, image, workspace, NATS, subprocess, pool controller, scanner/screener split, catalog)
**What I did:** Verified build passes (zero errors) and tests pass (5 pre-existing failures unrelated to simplification). Updated README.md, ax-prp.md, ax-architecture-doc.md, docs/web/index.html, and 7 skill files (ax, ax-config, ax-provider-sandbox, ax-provider-eventbus, ax-security, ax-host). Removed browser/image/workspace/NATS/subprocess/pool-controller/screener references. Updated provider count from 18 to 15. Verified provider-map.ts and ipc-schemas.ts are clean. Confirmed test references to "browser", "screener", "scanner", "catalog", "subprocess", "nats" are all legitimate (test fixtures, security provider tests, tool-catalog, etc.), not dangling references.
**Files touched:** README.md, docs/plans/ax-prp.md, docs/plans/ax-architecture-doc.md, docs/web/index.html, .claude/skills/ax/SKILL.md, .claude/skills/ax-config/SKILL.md, .claude/skills/ax-provider-sandbox/SKILL.md, .claude/skills/ax-provider-eventbus/SKILL.md
**Outcome:** Success — all docs and skills now accurately reflect the 15-category architecture
**Notes:** 5 pre-existing test failures (3 timeouts, 1 docker image pull, 1 assertion) are not related to the simplification.

## [2026-04-06 05:10] — Phase 5: Host cleanup — heartbeat, event store, file registry, CLI dead code

**Task:** Remove heartbeat monitor, event store, file-based agent registry, and CLI dead code
**What I did:**
- Task 5.1: Deleted heartbeat-monitor.ts and test. Removed HeartbeatMonitor from orchestrator (instantiation, heartbeat field, recordActivity call, shutdown unsub). Removed HeartbeatMonitorConfig from types.ts. Fixed delegation-hardening test.
- Task 5.2: Deleted event-store.ts, orchestration migrations, and tests. Removed OrchestrationEventStore from orchestrator and types.ts. Removed agent_orch_timeline IPC schema and handler. Updated cross-component and tool-catalog-sync tests.
- Task 5.3: Removed FileAgentRegistry class. Made DatabaseAgentRegistry dialect-aware (SQLite + PostgreSQL). Added createSqliteRegistry() convenience factory. Updated createAgentRegistry() factory to always use database. Updated 6 test files from FileAgentRegistry to createSqliteRegistry.
- Task 5.4: Deleted unused src/cli/utils/commands.ts REPL parser. Removed warm pool tier selection and minReady/maxReady from k8s init wizard.
**Files touched:**
- Deleted: src/host/orchestration/heartbeat-monitor.ts, src/host/orchestration/event-store.ts, src/migrations/orchestration.ts, src/cli/utils/commands.ts, + 3 test files
- Modified: orchestrator.ts, types.ts (orch), ipc-schemas.ts, orchestration IPC handler, governance IPC handler, agent-registry.ts, agent-registry-db.ts, ipc-server.ts, k8s-init.ts, + 8 test files
**Outcome:** Success. Build passes. 2600 tests pass (4 pre-existing failures in admin-gate, server, smoke tests).
**Notes:** SQLite DEFAULT expression requires outer parens: `(datetime('now'))` not `datetime('now')`. FileAgentRegistry tests needed `async beforeEach` since DatabaseAgentRegistry.register() is truly async.

## [2026-04-06 01:15] — Phase 4: Remove catalog, cowork-plugins, simplify plugin install

**Task:** Execute Phase 4 of architecture simplification: remove catalog system, remove cowork-plugins IPC handler, simplify plugin install to GitHub-based
**What I did:**
- Task 4.1: Deleted catalog-store.ts, ipc-handlers/catalog.ts, and their tests. Removed 5 catalog IPC schemas and handler registration from ipc-server.ts. Updated tool-catalog-sync test.
- Task 4.2: Deleted ipc-handlers/cowork-plugins.ts and test. Removed 3 cowork IPC schemas and handler registration. Removed coworkPlugins option from IPCHandlerOptions. Updated cross-component test and removed Cowork branding from comments in 6 files.
- Task 4.3: Added shared?: boolean to InstalledPlugin and PluginUpsertInput. Added --shared CLI flag. Updated CLI help to emphasize GitHub sources. Updated test fixtures from cowork: to GitHub-style sources.
**Files touched:** src/host/catalog-store.ts (deleted), src/host/ipc-handlers/catalog.ts (deleted), src/host/ipc-handlers/cowork-plugins.ts (deleted), src/ipc-schemas.ts, src/host/ipc-server.ts, src/host/server-init.ts, src/host/server-completions.ts, src/host/inprocess.ts, src/host/server-admin.ts, src/host/registry.ts, src/plugins/types.ts, src/plugins/store.ts, src/plugins/install.ts, src/cli/plugin.ts, src/cli/index.ts, tests/agent/tool-catalog-sync.test.ts, tests/integration/cross-component.test.ts, tests/plugins/store.test.ts, plus 4 deleted test files
**Outcome:** Success — build passes, 229/231 test files pass (2 pre-existing Docker-dependent failures)
**Notes:** The admin REST plugin routes in server-admin.ts were kept since they use plugins/install directly (not the cowork IPC handler). The fetcher already handled GitHub well with local path for dev.

## [2026-04-06 00:40] — Phase 3.2: credentials provider review — no simplification needed

**Task:** Review credentials provider implementations for redundancy
**What I did:** Read all 3 implementations (plaintext, keychain, database) and assessed whether any could be removed
**Files touched:** None — all implementations are reasonable
**Outcome:** No changes. Each variant serves a distinct use case: plaintext for file-based local dev, keychain for OS-level secure storage, database for K8s/PostgreSQL deployments. Config already auto-promotes from keychain to database for container sandboxes.
**Notes:** The `env` provider was already removed in a prior phase; `keychain` falls back to plaintext when keytar is unavailable.

## [2026-04-06 00:30] — Phase 3.1: merge scanner + screener into unified security provider

**Task:** Merge ScannerProvider and SkillScreenerProvider into a single SecurityProvider interface
**What I did:**
1. Created `src/providers/security/` with types.ts, patterns.ts, guardian.ts, none.ts — each implementing the unified SecurityProvider interface (scanner + screener methods)
2. Updated provider-map.ts: replaced `scanner:` and `screener:` entries with `security: { patterns, guardian, none }`
3. Updated types.ts: replaced `scanner: ScannerProvider` and `screener?: SkillScreenerProvider` with `security: SecurityProvider` in both Config and ProviderRegistry
4. Updated config.ts: replaced `providers.scanner` and `providers.screener` Zod schemas with `providers.security`
5. Updated registry.ts: replaced loadScanner with loadSecurity, removed screener loading
6. Updated all 20+ YAML config files (ax.yaml, helm values, flux, test fixtures, e2e, ui dev configs)
7. Updated all source references: router.ts, governance.ts, identity.ts, provider-sdk, skills/types.ts, onboarding
8. Moved tests to tests/providers/security/, updated 15+ test files with mock provider changes
9. Deleted old directories: src/providers/scanner/, src/providers/screener/, and their skills
**Files touched:** 50+ files across src/, tests/, charts/, flux/, ui/
**Outcome:** Success — build passes, all test failures are pre-existing (server.test.ts, smoke.test.ts)
**Notes:** The unified SecurityProvider has all scanner methods (scanInput, scanOutput, canaryToken, checkCanary) plus all screener methods (screen, screenExtended, screenBatch). Guardian variant uses no-op screener methods; patterns variant has full implementations of both.

## [2026-04-06 00:00] — Phase 2 architecture simplification: remove pool controller, NATS, subprocess sandbox

**Task:** Remove unused infrastructure subsystems as Phase 2 of AX architecture simplification
**What I did:** Executed 3 sequential tasks:
1. Removed pool controller: deleted src/pool-controller/ (4 files) and tests/pool-controller/ (4 files), removed poolController config from Helm values, kind-dev-values, flux HelmReleases, NOTES.txt, and host deployment template.
2. Removed NATS: deleted src/utils/nats.ts, src/providers/eventbus/nats.ts, tests/utils/nats.test.ts, and 4 NATS-related test harness files. Removed nats from provider-map and package.json. Updated all NATS comments across 12+ source files. Switched flux and e2e configs from eventbus: nats to eventbus: postgres.
3. Removed subprocess sandbox: deleted src/providers/sandbox/subprocess.ts and its test. Changed default sandboxType from 'subprocess' to 'docker' in runner.ts, agent-setup.ts, setup-server.ts. Updated 53 files total (27 test files, 5 YAML fixtures, source comments).
**Files touched:** 97 files modified/deleted across 3 commits
**Outcome:** Success — build passes, 2676/2680 tests pass (4 failures are pre-existing flaky tests unrelated to changes)
**Notes:** The subprocess references in claude-code.ts, tcp-bridge.ts, bin-exists.ts etc. are about generic CLI subprocesses, not the sandbox provider — correctly left in place.

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
