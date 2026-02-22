# Lessons Learned

### Configure wizard must set config.model for non-claude-code agents
**Date:** 2026-02-22
**Context:** Users running `bun serve` after configure got "config.model is required for LLM router" because the wizard never prompted for a model
**Lesson:** The LLM router (used by pi-agent-core, pi-coding-agent) requires `config.model` as a compound `provider/model` ID (e.g. `anthropic/claude-sonnet-4-20250514`). Only claude-code agents bypass the router (they use the credential-injecting proxy). Any new agent type that uses the router must have model selection in the wizard.
**Tags:** onboarding, config, llm-router, configure

### API key env var naming follows ${PROVIDER.toUpperCase()}_API_KEY convention
**Date:** 2026-02-22
**Context:** The openai.ts provider uses `envKey()` to derive env var names dynamically from provider names
**Lesson:** When writing API keys to .env, use `${llmProvider.toUpperCase()}_API_KEY` (e.g. OPENROUTER_API_KEY, GROQ_API_KEY). The ANTHROPIC_API_KEY is the special case/default. This convention matches what the provider implementations expect at runtime.
**Tags:** onboarding, env, api-key, providers

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

### OS username ≠ channel user ID — admins file seed doesn't help channels
**Date:** 2026-02-22
**Context:** Bootstrap gate blocks all Slack users because admins file is seeded with `process.env.USER` (OS username) but Slack messages come with Slack user IDs
**Lesson:** When seeding identity/access files, remember that the seeded value (OS username) only works for CLI/local access. Channel providers (Slack, Discord, etc.) use their own user ID formats. For channel access during bootstrap, use an auto-promotion mechanism (`.bootstrap-admin-claimed` atomic claim file) to let the first channel user become admin.
**Tags:** bootstrap, admin, channels, slack, user-id, access-control

### :memory: SQLite databases don't work with separate connections
**Date:** 2026-02-22
**Context:** Converting stores to use Kysely migrations. Kysely creates its own better-sqlite3 connection, runs migrations, then we destroy it and open a new connection via openDatabase(). For file paths this works since both connections see the same file. For :memory:, each connection is an independent in-memory database.
**Lesson:** When using createKyselyDb() + openDatabase() pattern (two separate connections), :memory: paths won't work because migrations run on one connection and queries on another. Tests must use temp file paths instead: `join(mkdtempSync(...), 'test.db')`. This is already the pattern in conversation-store and job-store tests.
**Tags:** sqlite, memory, testing, kysely, migrations, better-sqlite3

### Multiple TestHarness instances need careful dispose ordering
**Date:** 2026-02-22
**Context:** "database is not open" error when afterEach tried to dispose a harness that was already disposed
**Lesson:** If a test creates local TestHarness instances instead of using the module-level `harness`, either: (a) assign one to the module-level `harness` so afterEach handles it, or (b) dispose all local instances at the end of the test and ensure the module-level `harness` isn't stale from a prior test. The afterEach guard `harness?.dispose()` will re-dispose an already-disposed instance and crash on the closed SQLite db.
**Tags:** testing, e2e, harness, dispose, isolation

### Separate Kysely + openDatabase connections can't share :memory: databases
**Date:** 2026-02-22
**Context:** Migrating stores to use Kysely for migrations while keeping openDatabase() for queries
**Lesson:** When using `createKyselyDb` (which opens its own better-sqlite3 connection) alongside `openDatabase()`, `:memory:` databases won't work because each connection gets an independent in-memory database. Tests must use temp file paths instead. This applies whenever you have two separate SQLite connections to the same logical database.
**Tags:** sqlite, kysely, testing, memory-database, migrations

### ALTER TABLE ADD COLUMN has no IF NOT EXISTS in SQLite
**Date:** 2026-02-22
**Context:** Writing Kysely migration for memory store's agent_id column
**Lesson:** `ALTER TABLE ... ADD COLUMN` doesn't support `IF NOT EXISTS` in SQLite (or in Kysely's schema builder). For backwards-compatible migrations that add columns, wrap in try-catch to handle the "duplicate column" error. This is the correct pattern — Kysely's migration tracking prevents double-runs on fresh databases, and the try-catch handles pre-migration databases.
**Tags:** sqlite, kysely, migrations, alter-table, backwards-compatibility

### Always check runMigrations result.error in store factories
**Date:** 2026-02-22
**Context:** Code review caught that create() factories discarded the migration result
**Lesson:** `runMigrations()` returns `{ error }` instead of throwing. Always check `result.error` and throw it explicitly. Also wrap the Kysely lifecycle in try/finally to ensure `kyselyDb.destroy()` runs even on failure — otherwise you leak the connection.
**Tags:** kysely, migrations, error-handling, resource-cleanup
