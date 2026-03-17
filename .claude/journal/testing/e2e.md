# Testing: E2E

End-to-end test framework, simulated providers, scenario coverage.

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
