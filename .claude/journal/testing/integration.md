# Testing: Integration

Integration test fixes, CI stability, smoke test improvements.

## [2026-03-18 14:30] — Fix CI test failures for web_approve tool addition

**Task:** Fix 6 failing CI tests after web_approve tool was added to TOOL_CATALOG
**What I did:** Updated tool counts from 15→16 and added web_approve to expected tool lists in 4 test files
**Files touched:** tests/sandbox-isolation.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/agent/tool-catalog.test.ts
**Outcome:** Success — all 106 tests in the 4 files pass
**Notes:** The web_approve tool (web proxy governance) was added to tool-catalog.ts but tests weren't updated to reflect the new count

## [2026-03-17 16:00] — Create K8s-mode server test harness

**Task:** Create `tests/integration/k8s-server-harness.ts` — a reusable K8s-mode test fixture
**What I did:** Wrote a standalone harness that wires up NATS work delivery + HTTP IPC routes using `processCompletion()` directly (not `createServer()`). Includes per-turn token registry, agent_response interception, `/internal/ipc` and `/internal/workspace/release` HTTP routes, and the same public API shape as `ServerHarness`.
**Files touched:** `tests/integration/k8s-server-harness.ts` (created)
**Outcome:** Success — file written with all verified imports and matching API shape
**Notes:** Uses `processCompletion()` directly because `createServer()` lacks k8s-mode deps (publishWork, agentResponsePromise, /internal/ipc route, token registry). Pattern based on `tests/providers/sandbox/run-http-local.ts`.

## [2026-03-17 11:00] — Create Docker sandbox E2E test suite

**Task:** Create `tests/integration/e2e-docker.test.ts` — full feature test suite running all scenarios through the Docker sandbox provider
**What I did:** Created Docker E2E test file with 15 test cases covering: tool use (memory_write, sequential tools), streaming (SSE chunks), memory lifecycle (cross-turn persistence), bootstrap (identity_write), identity persistence (server restart), skills (propose/list/read), memory scoping (user isolation), workspace scoping (agent vs user tiers), scheduling (cron CRUD, run_at), content scanning (injection blocking, no canary/taint leaks), web proxy (SSRF blocking, canary detection via startWebProxy), concurrent sessions (3 parallel requests), and error handling (malformed JSON). Uses `execFileSync('docker', ['info'])` for detection with `describe.skipIf(!dockerAvailable)`. All test timeouts 90-180s for Docker startup latency. Uses server harness with scriptable LLM and real Docker sandbox from `src/providers/sandbox/docker.ts`.
**Files touched:** `tests/integration/e2e-docker.test.ts` (new)
**Outcome:** Success — compiles cleanly with zero TypeScript errors specific to the file
**Notes:** Web proxy test uses `startWebProxy()` directly (not through harness) with ephemeral TCP port and try/finally for cleanup. Identity persistence test uses `existingHome` option to pass home dir across harness lifetimes.

## [2026-03-17 10:00] — Create in-process server test harness

**Task:** Create `tests/integration/server-harness.ts` — a reusable harness that boots a real AX server inside the test process with mock providers
**What I did:** Created `server-harness.ts` with: (1) `HarnessOptions` interface accepting required llm/sandbox and optional web/config/providerOverrides/preStart/port/existingHome, (2) `ServerHarness` interface with server, home, socket, port, gcsBucket, sendMessage/sendMessages HTTP helpers, readFile/writeFile/fileExists fs helpers, and dispose cleanup, (3) `createHarness()` factory that creates temp AX_HOME, writes config YAML, initializes silent logger, loads config, builds provider overrides, starts server, and returns the harness. HTTP helpers use `node:http` request() to Unix socket or TCP.
**Files touched:** `tests/integration/server-harness.ts` (new)
**Outcome:** Success — compiles cleanly with zero TypeScript errors
**Notes:** Uses `createMockWeb()` and `createMockGcsBucket()` from the previously-created `mock-providers.ts`. The `existingHome` option supports identity persistence tests. The `port` option enables TCP listener for NATS harness tests.

## [2026-03-01 21:20] — Fix CI unhandled ENOENT in phase1.test.ts

**Task:** Fix failing CI caused by unhandled ENOENT error when pino's async file transport races with temp directory cleanup
**What I did:** (1) In `tests/integration/phase1.test.ts`, added `initLogger({ file: false, level: 'silent' })` before `loadProviders()` to prevent pino from creating an async file transport to the temp AX_HOME. (2) Added `resetLogger()` in the `finally` block. (3) Added regression test in `tests/logger.test.ts` verifying `initLogger({ file: false })` does not create ax.log.
**Files touched:** `tests/integration/phase1.test.ts`, `tests/logger.test.ts`
**Outcome:** Success — build clean, all 2006 tests pass (2005+1 new), zero unhandled errors
**Notes:** Root cause: `loadProviders()` imports LLM router module which has top-level `getLogger()` call. This created a pino file transport targeting `AX_HOME/data/ax.log`. When the test's `finally` block deleted the temp dir, pino's async worker thread threw ENOENT.

## [2026-02-27 02:35] — Fix flaky integration smoke tests

**Task:** Make the 4 flaky smoke tests more robust — they timed out under parallel CI load with "Server did not become ready in time" (stdout/stderr both empty).
**What I did:** Three changes to both `smoke.test.ts` and `history-smoke.test.ts`:
1. **Event-based readiness detection**: Replaced 100ms `setInterval` polling with event listeners on stdout/stderr that react immediately when `server_listening` appears. Also checks already-buffered output for race safety.
2. **Increased timeout from 15s to 45s**: The old 15s wasn't enough when `tsx` has to cold-start under heavy parallel load (167 test files). All stdout/stderr was empty — the process hadn't even started logging yet.
3. **Shared server processes**: Tests using the same config now share a single server via `beforeAll`/`afterAll` instead of each test spawning its own. smoke.test.ts shares 1 server across 4 core pipeline tests (saves 3 cold starts). history-smoke.test.ts shares 1 server across all 3 tests (saves 2 cold starts). Tests with custom env/config still get dedicated servers via a `withServer()` helper.
**Files touched:** tests/integration/smoke.test.ts, tests/integration/history-smoke.test.ts
**Outcome:** Success — 167/167 test files pass, 1721/1722 tests (1 skipped = macOS seatbelt), zero failures under full parallel load
**Notes:** Root cause was tsx cold-start time under heavy CPU/disk contention. The empty stdout/stderr proved the server process hadn't produced ANY output in 15s — not that it started but was slow to listen. The shared server approach also improves test suite speed: shared tests run in 3-6s each vs 7-15s when each spawned its own server.

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
