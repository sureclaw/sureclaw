# Lessons Learned

### pi-agent-core only supports text — image blocks must bypass it
**Date:** 2026-02-26
**Context:** Debugging why Slack image attachments weren't visible to the LLM despite being downloaded and stored correctly.
**Lesson:** pi-agent-core (`@mariozechner/pi-agent-core`) only handles text user messages. When the user message includes non-text content blocks (images), they must be extracted before entering pi-agent-core and injected into the IPC/LLM call messages separately. The injection point is in `createIPCStreamFn()` after `convertPiMessages()` runs — find the last user message with string content (the prompt, not tool results) and convert it to structured content with text + image blocks.
**Tags:** pi-agent-core, images, ipc-transport, slack, vision

### Popular OpenClaw skills use clawdbot alias, not openclaw
**Date:** 2026-02-26
**Context:** Implementing AgentSkills SKILL.md parser for gog, nano-banana-pro, and mcporter
**Lesson:** Real-world SKILL.md files use `metadata.clawdbot` (not `metadata.openclaw`) for their requirements blocks. Always check all three aliases (openclaw, clawdbot, clawdis) when resolving metadata. The parser must handle all of them or it will miss requirements from the most popular skills.
**Tags:** skills, parser, openclaw, clawdbot, compatibility

### Many skills have no metadata block — static analysis is essential
**Date:** 2026-02-26
**Context:** Parsing nano-banana-pro SKILL.md which only has name+description in frontmatter
**Lesson:** A significant fraction of real-world skills declare ZERO requirements in their YAML frontmatter. Their dependencies (binaries like `uv`, env vars like `GEMINI_API_KEY`, scripts like `scripts/generate_image.py`) are only mentioned in the markdown body or code blocks. The manifest generator's static analysis (regex scanning of body text and code blocks) is not optional — without it, these skills get empty manifests and are useless.
**Tags:** skills, manifest-generator, static-analysis, nano-banana-pro

### Tool count tests are scattered across many test files
**Date:** 2026-02-26
**Context:** Adding skill_import and skill_search tools caused failures in 5 different test files
**Lesson:** When adding new IPC tools, expect to update hardcoded tool counts in: tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts, and tests/agent/tool-catalog-sync.test.ts. Search for the old count (e.g. "25") across all test files before committing.
**Tags:** tools, testing, ipc, tool-catalog

### OpenClaw's security failures validate AX's zero-trust architecture
**Date:** 2026-02-25
**Context:** Researching OpenClaw's ClawHavoc supply chain attack for skills architecture comparison
**Lesson:** The ClawHavoc attack (824+ malicious skills on ClawHub) succeeded because: 1) no sandbox (skills run on host with full privileges), 2) no screening at upload time, 3) skills can bundle binaries added to PATH with no integrity verification, 4) no capability narrowing. AX's existing sandbox + IPC proxy + capabilities.yaml already prevents all of these attack vectors. When designing executable skills for AX, the sandbox is the runtime — binaries run inside it, not on the host. Untrusted skills must never be allowed to execute.
**Tags:** skills, security, openclaw, sandbox, supply-chain, architecture

### Node.js fetch body does not accept Buffer in strict TypeScript
**Date:** 2026-02-25
**Context:** Passing `att.content` (a Buffer) as `body` to `fetch()` in the Slack provider caused TS2769 — `Buffer` is not assignable to `BodyInit`.
**Lesson:** Wrap Buffer with `new Uint8Array(buffer)` when passing to `fetch()` body. Uint8Array is accepted by BodyInit; Buffer (which extends Uint8Array) is not in strict mode because of extra properties.
**Tags:** typescript, fetch, buffer, slack

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

### Changing prompt module output breaks tests in multiple locations
**Date:** 2026-02-23
**Context:** Changing the skills module from full content to progressive disclosure broke tests in skills.test.ts, sandbox-isolation.test.ts, integration.test.ts, and stream-utils.test.ts
**Lesson:** When modifying a prompt module's `render()` output, search for all tests that assert on that text: `grep -r "the old text" tests/`. Also check sandbox-isolation.test.ts (it reads source files), integration.test.ts (full builder test with hardcoded module counts and ordering), and stream-utils.test.ts (tests for helper functions that feed the module).
**Tags:** testing, prompt-modules, integration-tests, sandbox-isolation

### When adding new prompt modules, update integration test module count
**Date:** 2026-02-23
**Context:** Adding memory-recall and tool-style modules changed the module count from 5 to 7 in the full prompt integration test
**Lesson:** `tests/agent/prompt/integration.test.ts` has a hardcoded `moduleCount` assertion and per-module token breakdown check. When adding new modules: (1) update the count, (2) add the new module's token check, (3) verify ordering assertions include the new module.
**Tags:** testing, prompt-modules, integration-test, builder

### Explicit `permissions` in GitHub Actions replaces ALL defaults — always include `contents: read`
**Date:** 2026-02-25
**Context:** GitHub Pages workflow had `permissions: { pages: write, id-token: write }` but `actions/checkout` silently failed because `contents: read` was missing
**Lesson:** When setting `permissions` at the workflow or job level in GitHub Actions, you override ALL default token permissions. Only the permissions you list are granted. `actions/checkout` needs `contents: read` to clone the repo. Always include it when using explicit permissions. The checkout step may fail silently or produce cryptic errors without it.
**Tags:** github-actions, permissions, pages, checkout, ci
### Bootstrap lifecycle must be tested end-to-end including server restarts
**Date:** 2026-02-22
**Context:** Two bootstrap bugs went undetected: `.bootstrap-admin-claimed` never deleted, and BOOTSTRAP.md recreated on restart. Tests only covered individual helper functions and single-server-lifecycle scenarios.
**Lesson:** Any time server startup has initialization logic that depends on persisted state (like "copy file if not exists"), there MUST be a test that verifies the behavior across server restarts. Unit tests for helpers are not enough — the interaction between server startup copying and bootstrap completion deletion is where bugs hide.
**Tags:** bootstrap, lifecycle, integration-testing, server-restart

### isAgentBootstrapMode requires BOTH SOUL.md and IDENTITY.md to complete bootstrap
**Date:** 2026-02-22
**Context:** A test assumed writing just SOUL.md would trigger bootstrap completion and delete BOOTSTRAP.md. It was wrong — `isAgentBootstrapMode` returns true until BOTH files exist.
**Lesson:** When writing tests for multi-step completion logic (like bootstrap), always trace through the actual condition. `isAgentBootstrapMode` checks `!existsSync(SOUL.md) || !existsSync(IDENTITY.md)` — both must exist for it to return false. Tests must create both files before asserting completion behavior.
**Tags:** bootstrap, testing, conditions, identity

### Async toAnthropicContent requires Promise.all for message arrays
**Date:** 2026-02-25
**Context:** Making toAnthropicContent() async to resolve image file references
**Lesson:** When converting a content mapping function from sync to async (e.g., to resolve file references), all callers that use `.map()` must be updated to `await Promise.all(messages.map(async ...))`. In the Anthropic provider, this means the `.chat()` method's message building loop needs Promise.all for both the message-level and content-block-level mapping.
**Tags:** async, anthropic, llm, images, promise-all

### Structured content serialization — use JSON detection on load
**Date:** 2026-02-25
**Context:** Storing ContentBlock[] in SQLite TEXT columns alongside plain string content
**Lesson:** For backward-compatible structured content in SQLite TEXT columns: serialize arrays with JSON.stringify, leave strings as-is. On load, detect JSON arrays by checking if the string starts with `[` and parse accordingly. This avoids schema migrations and handles both old (plain text) and new (structured) data transparently.
**Tags:** sqlite, content-blocks, serialization, conversation-store, backward-compatibility

### onDelegate callback signature changes require updating all test files + harness
**Date:** 2026-02-25
**Context:** Changed onDelegate from `(task, context, ctx)` to `(req: DelegateRequest, ctx)` — tests broke in 4 locations
**Lesson:** When changing an IPC handler callback signature, update: (1) ipc-server.ts (type definition), (2) delegation.ts (handler implementation), (3) harness.ts (HarnessOptions type), (4) all test files that pass the callback: unit tests, e2e tests, and integration tests. Grep for the old function name across all test directories.
**Tags:** ipc, delegation, testing, callback-signatures, refactoring

### Renaming a Config field has massive blast radius — check YAML fixtures too
**Date:** 2026-02-26
**Context:** Renamed `config.model` + `config.model_fallbacks` to `config.models` array. First test run after updating source had 8 test file failures because 6 YAML test fixtures and 2 inline test configs still used the old `model:` field. Zod strict mode rejected the unrecognized key.
**Lesson:** When renaming a Config field: (1) grep all `.yaml` files under tests/ for the old field name, (2) grep all `.test.ts` files for inline config objects using the old name, (3) remember that Zod `.strict()` mode means any unrecognized key causes a hard failure — there's no graceful fallback. The YAML fixtures are especially easy to miss because they're data files, not code.
**Tags:** config, testing, yaml, zod, strict-mode, rename-blast-radius

### AgentConfig.model is NOT the same as Config.model — check the type before renaming
**Date:** 2026-02-26
**Context:** When renaming `Config.model` to `Config.models`, initially thought ALL `config.model` references needed updating. But `AgentConfig` in runner.ts has its own `model` field (agent-side model from CLI args) that is a completely different type.
**Lesson:** Before bulk-renaming a field across the codebase, verify which TYPE each `config.model` reference belongs to. `Config` (from ax.yaml, host-side) and `AgentConfig` (from CLI args, agent-side) are different types with different `model` fields. Use TypeScript's type system or grep for the import to disambiguate.
**Tags:** config, types, rename, agent-config, disambiguation
