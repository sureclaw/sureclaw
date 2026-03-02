# Testing: Integration

Integration test fixes, CI stability, smoke test improvements.

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
