# Testing Infrastructure

### Tool count tests are scattered across many test files
**Date:** 2026-02-26
**Context:** Adding skill_import and skill_search tools caused failures in 5 different test files
**Lesson:** When adding new IPC tools, expect to update hardcoded tool counts in: tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts, and tests/agent/tool-catalog-sync.test.ts. Search for the old count (e.g. "25") across all test files before committing.
**Tags:** tools, testing, ipc, tool-catalog

### Tool count is hardcoded in multiple test files — update all of them
**Date:** 2026-02-22
**Context:** After adding 6 enterprise tools (17→23), tests failed in 5 different files that each hardcoded the expected tool count
**Lesson:** When adding new tools, search for the old count number across all test files: `grep -r 'toBe(17)' tests/` (or whatever the old count is). Files to check: tool-catalog.test.ts, ipc-tools.test.ts, mcp-server.test.ts, tool-catalog-sync.test.ts, sandbox-isolation.test.ts.
**Tags:** tools, testing, tool-catalog, mcp-server, ipc-tools

### Set AX_HOME in tests that use workspace/identity/scratch paths
**Date:** 2026-02-22
**Context:** Workspace tests failed because paths.ts resolved to `~/.ax/` instead of the test temp dir
**Lesson:** The workspace handler uses `agentWorkspaceDir()`, `userWorkspaceDir()`, `scratchDir()` from `src/paths.ts`, which all resolve relative to `process.env.AX_HOME || ~/.ax/`. Set `process.env.AX_HOME` to a temp dir in test setup and restore in teardown for filesystem isolation.
**Tags:** testing, workspace, paths, AX_HOME, isolation

### scratchDir requires valid session ID format
**Date:** 2026-02-22
**Context:** Workspace scratch test failed with "Invalid session ID for scratch dir"
**Lesson:** `scratchDir()` validates session IDs: must be either a lowercase UUID (`/^[0-9a-f]{8}-[0-9a-f]{4}-...$/`) or 3+ colon-separated segments matching `SEGMENT_RE`. Simple strings like `test-session` are rejected. Use `randomUUID()` for test session IDs when touching scratch tier.
**Tags:** testing, scratch, session-id, validation

### Multiple TestHarness instances need careful dispose ordering
**Date:** 2026-02-22
**Context:** "database is not open" error when afterEach tried to dispose a harness that was already disposed
**Lesson:** If a test creates local TestHarness instances instead of using the module-level `harness`, either: (a) assign one to the module-level `harness` so afterEach handles it, or (b) dispose all local instances at the end of the test and ensure the module-level `harness` isn't stale from a prior test. The afterEach guard `harness?.dispose()` will re-dispose an already-disposed instance and crash on the closed SQLite db.
**Tags:** testing, e2e, harness, dispose, isolation

### Integration tests that spawn server processes need shared servers and long timeouts
**Date:** 2026-02-27
**Context:** Smoke tests timed out under full parallel CI load — 4 tests failed with empty stdout/stderr because tsx cold-start exceeded the 15s timeout when 167 test files ran simultaneously.
**Lesson:** When tests spawn child processes (e.g., `npx tsx src/main.ts`), the cold-start cost is high and unpredictable under parallel load. Three fixes: (1) Increase `waitForReady` timeout to 45s minimum — tsx cold-start under contention can easily take 20-30s. (2) Use event listeners on stdout/stderr instead of setInterval polling — react immediately when the readiness marker appears. (3) Share server processes across compatible tests using `beforeAll`/`afterAll` — reduces total spawn count and eliminates repeated cold starts. Tests sharing a server must use random session IDs to avoid state contamination.
**Tags:** testing, integration, flaky, timeout, child-process, shared-server, beforeAll

### Always run full test suite before committing — targeted runs miss sync tests
**Date:** 2026-02-27
**Context:** Initial commit passed 53 new + 383 targeted tests, but CI caught 8 failures in agent/sync test files that weren't included in the targeted run.
**Lesson:** Always run `npm test -- --run` (full suite) before committing, not just the test files you touched. The tool-catalog-sync, sandbox-isolation, and ipc-server tests verify cross-module consistency (tool catalog ↔ MCP server ↔ IPC schemas ↔ handlers). These sync tests catch issues that per-module tests miss. Running only host/ tests after adding IPC schemas will miss the agent/ sync tests that verify those schemas have handlers.
**Tags:** testing, ci, sync-tests, full-suite, workflow

### Always disable pino file transport in tests that set AX_HOME to a temp dir
**Date:** 2026-03-01
**Context:** The phase1 integration test set `AX_HOME` to a temp dir, called `loadProviders()`, then deleted the temp dir. Pino's async worker thread raced with the cleanup and threw an unhandled ENOENT for `data/ax.log`.
**Lesson:** When a test sets `AX_HOME` to a temp directory and loads providers or any code that triggers `getLogger()`, always call `initLogger({ file: false, level: 'silent' })` before the code under test, and `resetLogger()` in the `finally` block. Module-level `getLogger()` calls in provider modules (e.g. `llm/router.ts`) will create the singleton on first import.
**Tags:** testing, pino, logger, AX_HOME, race-condition, cleanup
