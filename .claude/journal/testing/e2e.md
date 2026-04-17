# Testing: E2E

End-to-end test framework, simulated providers, scenario coverage.

## [2026-04-16 00:17] — Phase 2 Task 10: git-native skills e2e smoke

**Task:** Write an end-to-end test that exercises the full phase 2 wire — post-receive hook fires on push → HMAC → in-process HTTP endpoint → real reconcileAgent → state store + event bus. No stubs for anything shipped in phase 2.
**What I did:** Created `tests/host/skills/e2e-reconcile.test.ts`. Stood up an in-process HTTP server on an ephemeral port wired to `createReconcileHookHandler` + real `reconcileAgent` (real snapshot builder, real state store on in-memory sqlite, real event bus, real `loadCurrentState`). Only provider-boundary stubs for `ProxyDomainList`, `CredentialProvider`, and MCP manager (omitted). Bare repo initialized, `installPostReceiveHook(bareRepoPath, 'agent-e2e')` installs the shell hook. A cloned working tree commits `.ax/skills/demo/SKILL.md` with valid frontmatter and pushes. The push subprocess env carries `AX_HOST_URL` + `AX_HOOK_SECRET`. Test polls `stateStore.getPriorStates('agent-e2e')` up to 5s because the hook runs asynchronously after the push subprocess exits. Gated on `hasCommand('openssl'/'curl'/'git')` — table stakes, but skip-clean if absent.
**Files touched:** `tests/host/skills/e2e-reconcile.test.ts` (new)
**Outcome:** Success — passed first try. All 15 skills test files (80 tests) pass, `tsc` build clean.
**Notes:** Had to add explicit `git config user.name` / `user.email` in the work tree — `childEnv` GIT_* vars cover commit but not all git operations on CI. The `git symbolic-ref HEAD refs/heads/main` on the bare repo is wrapped in try/catch because some git versions default to main. Stderr from `git push` is captured for debug output if the polling deadline is missed.

## [2026-03-20] — Update ax-debug skill to prefer e2e infrastructure

**Task:** Restructure ax-debug skill to use e2e test infrastructure as the primary debugging approach
**What I did:** Rewrote ax-debug skill with a 3-tier hierarchy: (1) E2E test infrastructure (preferred — deterministic, CI-friendly), (2) Kind cluster dev loop (production-parity pod behavior), (3) Local process harnesses (debugger attachment). Added Tier 1 section documenting the full e2e architecture, debugging workflow, how to add reproduction tests and scripted turns, and when to escalate. Updated "Debugging Specific Issues" section to lead with Tier 1 steps. All existing Tier 2/3 content preserved.
**Files touched:** .claude/skills/ax-debug/SKILL.md (rewritten)
**Outcome:** Success — skill now directs to e2e tests first with clear escalation criteria
**Notes:** The key insight is that most bugs can be reproduced with a scripted turn + test case, avoiding the overhead of manual kind cluster setup or local process juggling.

## [2026-03-20] — Update skills to match test restructuring

**Task:** Update ax-testing, ax-debug, and acceptance-test skills to reflect recent commits that restructured tests
**What I did:**
1. Deleted `acceptance-test` skill — the entire `tests/acceptance/` directory was removed; the manual test plan approach was replaced by automated vitest regression tests in `tests/e2e/`
2. Updated `ax-testing` skill — refreshed the complete directory listing to match current files, removed references to deleted `tests/e2e/scenarios/`, added new e2e regression test section, added `npm run test:e2e` command, documented ScriptedTurn pattern and mock server architecture
3. Left `ax-debug` skill unchanged — all referenced files still exist (`scripts/k8s-dev.sh`, `run-http-local.ts`, etc.)
**Files touched:** .claude/skills/acceptance-test/SKILL.md (deleted), .claude/skills/ax-testing/SKILL.md (rewritten)
**Outcome:** Success — skills now accurately reflect the codebase
**Notes:** The old acceptance-test skill was a 1000-line manual workflow for spawning agents against live servers. The new tests/e2e/ approach uses mock servers with scripted LLM responses, making tests deterministic and CI-friendly.

## [2026-03-20 10:50] — Restructure acceptance tests into tests/e2e/

**Task:** Refactor test directory structure: delete old tests/e2e/, flatten tests/acceptance/automated/, split scripted-turns.ts into modules, rename tests/acceptance/ to tests/e2e/
**What I did:**
1. Deleted old tests/e2e/ (8 sandbox test files, superseded)
2. Flattened tests/acceptance/automated/* up one level into tests/acceptance/
3. Split scripted-turns.ts into tests/acceptance/scripts/ with individual files per turn category (types, bootstrap, chat, skills, memory, scheduler, index)
4. Renamed tests/acceptance/ to tests/e2e/ via git mv
5. Updated import in mock-server/openrouter.ts (../scripted-turns.js -> ../scripts/index.js)
6. Updated tests/e2e/vitest.config.ts paths
7. Updated root vitest.config.ts excludes (removed old tests/acceptance/automated/** entry)
8. Renamed package.json script test:acceptance -> test:e2e
**Files touched:**
- Deleted: tests/e2e/ (old), tests/acceptance/automated/, tests/acceptance/scripted-turns.ts
- Created: tests/e2e/scripts/{types,bootstrap,chat,skills,memory,scheduler,index}.ts
- Modified: tests/e2e/mock-server/openrouter.ts, tests/e2e/vitest.config.ts, vitest.config.ts, package.json
**Outcome:** Success — 215 test files, 2478 tests pass. Mock server verified. All imports clean.
**Notes:** git mv required staging the flattened state first since git tracked the old automated/ paths.

## [2026-03-20 10:10] — Delete Layer A scenario tests, keep Layer B sandbox tests

**Task:** Remove Layer A scenario tests from tests/e2e/ while preserving Layer B sandbox tests
**What I did:** Verified import dependencies before deleting. Found that `scriptable-llm.ts` and `mock-providers.ts` are imported by all 4 kept test files and both server harnesses, so they were NOT deleted. Deleted `tests/e2e/scenarios/` (13 test files), `tests/e2e/harness.ts`, and `tests/e2e/scripted-llm.ts`. Staged deletions and ran full test suite (215 files, 2478 tests pass).
**Files touched:** Deleted 15 files (13 scenario tests + harness.ts + scripted-llm.ts), 3740 lines removed
**Outcome:** Success — no test regressions
**Notes:** `scriptable-llm.ts` and `mock-providers.ts` could not be deleted as originally planned because Layer B files depend on them. `vitest.e2e.config.ts` kept (still needed for Layer B tests).

## [2026-03-17 16:00] — K8s Docker E2E simulation: full stack implementation

**Task:** Create Docker+NATS E2E tests simulating k8s host+sandbox communication
**What I did:** Built three new files + fixed existing k8s path tests:
1. `tests/providers/sandbox/docker-nats.ts` — Docker container with NATS/HTTP IPC (k8s simulation)
2. `tests/integration/k8s-server-harness.ts` — Server harness with NATS publishWork, /internal/ipc route, token registry, agent_response interception
3. `tests/integration/e2e-k8s-docker.test.ts` — 7 E2E tests through Docker + NATS + HTTP IPC
4. Fixed `tests/integration/e2e-k8s-path.test.ts` — switched to k8s-server-harness, fixing pre-existing publishWork gap
**Files touched:**
- New: tests/providers/sandbox/docker-nats.ts, tests/integration/k8s-server-harness.ts, tests/integration/e2e-k8s-docker.test.ts, docs/plans/2026-03-17-k8s-docker-e2e-tests.md
- Modified: tests/integration/e2e-k8s-path.test.ts
**Outcome:** Success — K8s path tests: 7/7 passed (~10s). Docker+NATS tests created, require Docker + nats-server.
**Notes:** Key bugs found: (1) NATS subject mismatch — agents subscribe to `sandbox.work` queue group, not the old `agent.work.{podName}` per-pod subject. (2) Streaming test assertion — k8s mode uses agentResponsePromise, not SSE. (3) Docker E2E tests on macOS are fundamentally broken — Unix domain sockets don't work across Docker Desktop VM boundary (ENOTSUP). Pre-existing issue, not introduced by our changes.

## [2026-03-17 15:00] — Docker+NATS E2E test file

**Task:** Create the E2E test file that exercises feature scenarios through a real Docker container communicating via NATS+HTTP IPC
**What I did:** Created `tests/integration/e2e-k8s-docker.test.ts` with 7 test scenarios: basic message, tool use, streaming, bootstrap, scheduler CRUD, guardian injection blocking, and web proxy SSRF blocking. Tests auto-detect Docker + nats-server; skip when unavailable. Auto-starts nats-server if not running. Builds fresh Docker image in beforeAll (npm run build + docker build). Uses `createK8sHarness` from k8s-server-harness.ts and `createDockerNATS` from docker-nats.ts.
**Files touched:**
- New: tests/integration/e2e-k8s-docker.test.ts
**Outcome:** Success — file created with all 7 scenarios matching the pattern from e2e-docker.test.ts and e2e-k8s-path.test.ts.
**Notes:** 180s timeouts for container tests, 300s for beforeAll (build+docker build). Uses `AX_DOCKER_IMAGE` env var save/restore pattern. Port randomized in 19000-19999 range.

## [2026-03-17 14:00] — Docker+NATS hybrid sandbox provider

**Task:** Create a hybrid sandbox provider that runs agent in Docker container but communicates via NATS work delivery + HTTP IPC (like real k8s)
**What I did:** Created `tests/providers/sandbox/docker-nats.ts` with `create(config, opts)` factory. Combines Docker container isolation (security hardening: read-only root, cap-drop=ALL, non-root user 1000, no-new-privileges, 64MB tmpfs) with k8s communication path (NATS work delivery, HTTP IPC). Uses bridge network + `host.docker.internal` to reach NATS and host HTTP endpoints.
**Files touched:**
- New: tests/providers/sandbox/docker-nats.ts
**Outcome:** Success — file created with full Docker args, canonical path mounts, NATS/HTTP env vars, podName for triggering host's NATS code path.
**Notes:** Sits alongside existing `nats-subprocess.ts` (bare process + NATS). Key difference: this one adds Docker container isolation. Uses `canonicalEnv()` then deletes `AX_IPC_SOCKET` since HTTP IPC replaces Unix sockets. `DockerNATSOptions` requires `hostUrl` and optionally `natsUrl` (defaults to `nats://host.docker.internal:4222`).

## [2026-03-17 12:00] — K8s path (NATS subprocess) E2E test file

**Task:** Create E2E tests for the NATS work delivery + HTTP IPC code path (k8s sandbox)
**What I did:** Created `tests/integration/e2e-k8s-path.test.ts` with 7 test scenarios that exercise the full k8s code path through NATS subprocess + HTTP IPC transport. Tests auto-detect NATS availability and skip when nats-server is not running. Uses `createHarness` with TCP port (not Unix socket) and `createNATSSubprocess` with `ipcTransport: 'http'`.
**Files touched:**
- New: tests/integration/e2e-k8s-path.test.ts
**Outcome:** Success — file created, type-checks cleanly. 7 scenarios: basic message, tool use, streaming, bootstrap, scheduler CRUD, guardian injection blocking, web proxy SSRF blocking.
**Notes:** The `createScriptableLLM` and `createHarness` helpers from `server-harness.ts` and `scriptable-llm.ts` were not yet used by any test files before this. The `port` option on `createHarness` enables TCP listener for NATS (which needs TCP, not Unix socket). The `k8sSandbox()` helper sets `AX_HOST_URL` and `PORT` env vars that `createNATSSubprocess` reads to configure the agent's HTTP IPC target.

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
