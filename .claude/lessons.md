# Lessons Learned

### safePath() treats its arguments as individual path segments, not relative paths
**Date:** 2026-02-22
**Context:** Workspace handler was producing flat filenames like `deep_nested_file.txt` instead of nested paths
**Lesson:** `safePath(base, 'deep/nested/file.txt')` treats the second arg as a single segment and replaces `/` with `_`. For relative paths from user input, split on `/` and `\` first: `safePath(base, ...relativePath.split(/[/\\]/).filter(Boolean))`. Created `safePathFromRelative()` helper for this pattern.
**Tags:** safePath, security, SC-SEC-004, path-traversal, workspace

### Declare variables before try blocks if they're needed in finally
**Date:** 2026-02-22
**Context:** `enterpriseScratch` was declared as `const` inside a try block but referenced in the finally block for cleanup
**Lesson:** If a variable is used in both try and finally, declare it with `let` before the try block. `const` inside try is scoped to the try block and invisible to finally/catch.
**Tags:** typescript, scoping, try-finally, server-completions

### Tool count is hardcoded in multiple test files — update all of them
**Date:** 2026-02-22
**Context:** After adding 6 enterprise tools (17→23), tests failed in 5 different files that each hardcoded the expected tool count
**Lesson:** When adding new tools, search for the old count number across all test files: `grep -r 'toBe(17)' tests/` (or whatever the old count is). Files to check: tool-catalog.test.ts, ipc-tools.test.ts, mcp-server.test.ts, tool-catalog-sync.test.ts, sandbox-isolation.test.ts.
**Tags:** tools, testing, tool-catalog, mcp-server, ipc-tools

### ipcAction() auto-registers schemas in IPC_SCHEMAS — just call it at module level
**Date:** 2026-02-22
**Context:** Adding enterprise IPC schemas to ipc-schemas.ts
**Lesson:** The `ipcAction()` builder function both creates and registers Zod schemas in the `IPC_SCHEMAS` map as a side effect. Just call it at module level — no separate registration step needed. All schemas use `.strict()` mode for safety.
**Tags:** ipc, schemas, zod, ipc-schemas

### Pre-existing tsc errors are expected — project uses tsx runtime
**Date:** 2026-02-22
**Context:** `npm run build` (tsc) shows 400+ errors from missing @types/node
**Lesson:** The AX project runs via tsx, not compiled tsc output. The 400+ tsc errors from missing @types/node are pre-existing and expected. Don't try to fix them — focus on vitest test results instead.
**Tags:** build, typescript, tsx, tsc

### New path helpers must handle colon-separated session IDs
**Date:** 2026-02-22
**Context:** `scratchDir()` used `validatePathSegment()` (alphanumeric/dash/underscore only), but channel session IDs like `test:thread:C02:2000.0001` contain colons and dots
**Lesson:** When adding new path functions that accept session IDs, use `isValidSessionId()` for validation and split colons into nested directories (same pattern as `workspaceDir()`). Don't use `validatePathSegment()` for session IDs — it's only for single-segment identifiers like agent names or user IDs.
**Tags:** paths, session-id, scratchDir, workspaceDir, validation

### child.killed is true after ANY kill() call, not just after the process is dead
**Date:** 2026-02-22
**Context:** `enforceTimeout` was checking `child.killed` to skip SIGKILL after SIGTERM, but `child.killed` is set to `true` the moment `kill()` is called, regardless of whether the process actually exited.
**Lesson:** Use a custom `exited` flag set via `child.on('exit', ...)` to track whether the process has actually terminated. Don't rely on `child.killed` to mean "the process is dead" — it only means "we've called kill() on it".
**Tags:** child_process, node.js, signals, SIGTERM, SIGKILL, sandbox

### Retry tests with real backoff delays need careful design
**Date:** 2026-02-22
**Context:** Channel reconnect test was timing out because it used the production retry config (2s initial delay, 5 retries) with 100 failures = 60+ seconds
**Lesson:** When testing code that uses `withRetry()` with production delay constants, either: (1) keep failure counts below max retries to avoid real timeout accumulation, (2) test the retry logic separately (already covered by retry.test.ts), or (3) make the retry options configurable and pass fast options in tests. Permanent error tests (auth errors that skip retry) are always fast and safe.
**Tags:** testing, retry, timeout, vitest, backoff

### Regex tests on source code are fragile — prefer semantic assertions
**Date:** 2026-02-22
**Context:** sandbox-isolation.test.ts used `expect(source).toMatch(/sandbox\.spawn\(\{[^}]*agentDir/s)` which broke when the spawn config was extracted into a variable.
**Lesson:** Tests that regex-match source code break whenever the code is refactored (extract variable, reorder params, etc.). Prefer simpler checks: `toContain('agentDir')` + `toMatch(/sandbox\.spawn/)` is more resilient. Even better, test behavior rather than code structure.
**Tags:** testing, regex, source-code-tests, refactoring

### IPC handler response shapes vary by handler — check the actual handler code
**Date:** 2026-02-22
**Context:** Writing E2E tests, expected `result.results` for web_search but it was `result[0]`
**Lesson:** IPC handlers return arbitrary objects/arrays that get spread into `{ ok: true, ...result }`. Some handlers return arrays (web_search → SearchResult[]), which become indexed keys (result[0], result[1]). Others return flat objects (web_fetch → { status, headers, body, taint }). Always read the handler source to know the response shape — don't assume wrapping like `result.response.status`.
**Tags:** ipc, testing, web, handlers, response-shape

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

### IPC schema enums must use exact values — check ipc-schemas.ts
**Date:** 2026-02-22
**Context:** `identity_propose` tests failed with "Validation failed" because `origin: 'agent'` doesn't match the Zod enum `['user_request', 'agent_initiated']`
**Lesson:** Always check the Zod schema in `src/ipc-schemas.ts` before writing IPC test assertions. Schema fields like `origin`, `decision`, `status`, and `file` use strict enums. Common gotcha: `IDENTITY_ORIGINS = ['user_request', 'agent_initiated']`, not `'agent'` or `'user'`. Similarly, `proposalId` and `memory_read.id` must be valid UUIDs.
**Tags:** ipc, schemas, zod, testing, validation, governance

### Multiple TestHarness instances need careful dispose ordering
**Date:** 2026-02-22
**Context:** "database is not open" error when afterEach tried to dispose a harness that was already disposed
**Lesson:** If a test creates local TestHarness instances instead of using the module-level `harness`, either: (a) assign one to the module-level `harness` so afterEach handles it, or (b) dispose all local instances at the end of the test and ensure the module-level `harness` isn't stale from a prior test. The afterEach guard `harness?.dispose()` will re-dispose an already-disposed instance and crash on the closed SQLite db.
**Tags:** testing, e2e, harness, dispose, isolation

