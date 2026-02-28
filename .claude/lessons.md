# Lessons Learned

### import.meta.resolve() is the secure way to resolve package names
**Date:** 2026-02-28
**Context:** Analyzing security of monorepo split — switching provider-map from relative paths to @ax/provider-* package names
**Lesson:** When using dynamic `import(packageName)`, Node.js resolves from CWD upward through the node_modules hierarchy. An attacker who controls CWD can shadow any package. Use `import.meta.resolve(packageName)` instead — it resolves from the calling module's location (like `new URL(path, import.meta.url)` does for relative paths). Stable since Node 20.6.
**Tags:** security, import, node-modules, cwd-hijacking, provider-map, SC-SEC-002

### pi-coding-agent does NOT re-export pi-agent-core types
**Date:** 2026-02-27
**Context:** Removing pi-agent-core as a user-facing agent type — expected to also drop the npm dep
**Lesson:** `@mariozechner/pi-coding-agent` does not re-export `Agent`, `AgentTool`, `StreamFn`, or `AgentMessage` from `@mariozechner/pi-agent-core`. If you need these types, you must either keep pi-agent-core as a direct dep or create a local barrel re-export. Check package exports (`dist/index.d.ts`) before assuming transitive deps surface their types.
**Tags:** pi-agent-core, pi-coding-agent, npm, types, dependencies

### Promise.race timeouts MUST be cleared in finally blocks
**Date:** 2026-02-27
**Context:** Diagnosing server crashes under 3 concurrent delegation agents
**Lesson:** Every `Promise.race([handler, timeout])` pattern MUST store the timeout ID and call `clearTimeout()` in a finally block. Without this, each call leaks a long-lived timer (15 min in our case). Under concurrent agent delegations, hundreds of leaked timers accumulate, causing memory pressure and eventual OOM. The pattern: `let timeoutId; try { timeoutId = setTimeout(...); await Promise.race(...); } finally { clearTimeout(timeoutId); }`
**Tags:** ipc, timer-leak, promise-race, memory-leak, delegation

### Test concurrent async handlers using the handler factory directly, not the IPC wrapper
**Date:** 2026-02-27
**Context:** Writing tests for concurrent delegation that timed out at 30s
**Lesson:** When testing concurrent handler behavior (concurrency limits, counters), call `createDelegationHandlers()` directly instead of going through `createIPCHandler()`. The IPC handler wraps every call in a 15-minute `Promise.race` timeout, which blocks tests that use blocking promises. Also: when a test fires a blocking delegation and later needs to verify "counter resets to 0", DON'T `await` the verification call directly — fire it without await, push the resolver, THEN await. Otherwise you deadlock: the await waits for the resolver that hasn't been pushed yet.
**Tags:** testing, delegation, concurrency, deadlock, ipc-handler

### Always clean up Map entries in ALL code paths (success AND error)
**Date:** 2026-02-27
**Context:** Found sessionCanaries map leak causing OOM on repeated delegation failures
**Lesson:** When a Map entry is set before a try block (like `sessionCanaries.set(id, token)`), ensure the corresponding `.delete()` is in BOTH the success path AND the catch block. Using try/finally for cleanup is ideal but may conflict if the success path needs to delete before returning. At minimum, add the cleanup to the catch block alongside `db.fail()`.
**Tags:** memory-leak, map-cleanup, error-handling, sessionCanaries

### Never use tsx binary as a process wrapper — use `node --import tsx/esm` instead
**Date:** 2026-02-27
**Context:** Diagnosing agent delegation failures — tsx wrapper caused EPERM, orphaned processes, and corrupted exit codes
**Lesson:** The tsx binary (`node_modules/.bin/tsx`) spawns a child Node.js process and relays signals via `relaySignalToChild`. On macOS, this relay fails with EPERM, and tsx has no error handling for it. Always use `node --import <absolute-path-to-tsx/dist/esm/index.mjs>` instead — single process, no signal relay issues. The absolute path is mandatory because agents run with cwd=workspace (temp dir with no node_modules).
**Tags:** tsx, process management, macOS, signal handling, EPERM, sandbox

### Retry logic must check for valid output before retrying
**Date:** 2026-02-27
**Context:** Agents completed work but got retried because the tsx wrapper crashed with exit code 1
**Lesson:** When an agent subprocess exits non-zero but produced valid stdout output, accept the output instead of retrying. The wrapper crash is irrelevant if the agent finished its work. In `server-completions.ts`, check `response.trim().length > 0` before entering the transient-failure retry path.
**Tags:** retry, fault tolerance, agent lifecycle, exit codes

### Provider contract pattern IS the plugin framework — packaging is the missing piece
**Date:** 2026-02-26
**Context:** Evaluating whether AX needs a plugin framework for extensibility
**Lesson:** AX's provider contract pattern (TypeScript interface + `create(config)` factory + static allowlist in provider-map.ts) is already 90% of a plugin framework. The gap is packaging and distribution, not architecture. A monorepo split into scoped npm packages (@ax/provider-{kind}-{name}) can shrink core to ~3K LOC while preserving the static allowlist security invariant. The allowlist entries just change from relative paths to package names. No new trust boundary needed for first-party packages.
**Tags:** architecture, plugins, providers, provider-map, monorepo, packaging

### Static allowlist (SC-SEC-002) can point to package names, not just relative paths
**Date:** 2026-02-26
**Context:** Designing how provider-map.ts would work after a monorepo split
**Lesson:** `resolveProviderPath()` currently resolves relative paths via `new URL(relativePath, import.meta.url)`. For npm packages, it can use `import('@ax/provider-llm-anthropic')` instead — this is still a static allowlist (hardcoded package names, not config-derived), so SC-SEC-002 is preserved. The key invariant is "no dynamic path construction from config values," not "paths must be relative."
**Tags:** security, SC-SEC-002, provider-map, npm-packages, static-allowlist

### Node.js Buffer → fetch body: use standalone ArrayBuffer to avoid detached buffer errors
**Date:** 2026-02-25
**Context:** Slack file upload failed with "fetch failed" / "Cannot perform ArrayBuffer.prototype.slice on a detached ArrayBuffer"
**Lesson:** Node.js Buffers share an internal memory pool. When passing binary data to `fetch()` as a body, `new Uint8Array(buffer)` still references the pool's shared ArrayBuffer, which undici detaches during send. The fix is to create a standalone ArrayBuffer: `const ab = new ArrayBuffer(buf.byteLength); new Uint8Array(ab).set(buf);` then pass `ab` as the body. This ensures the ArrayBuffer is independent of the Buffer pool and won't be detached prematurely.
**Tags:** node, buffer, fetch, undici, arraybuffer, detached, slack, upload

### IPC schemas use z.strictObject — extra fields cause silent validation failures
**Date:** 2026-02-25
**Context:** Adding `_sessionId` to IPC requests for session-scoped image generation. All server/integration tests started failing with empty responses.
**Lesson:** All IPC schemas in `src/ipc-schemas.ts` use `z.strictObject()` which rejects any unknown fields. When adding metadata fields to IPC requests (like `_sessionId`), you MUST strip them from the parsed object BEFORE passing it to schema validation. The pattern is: extract the field, delete it from parsed, then validate. This is easy to miss because the validation failure is caught and returns a generic error, making the agent produce empty output with exit code 0.
**Tags:** ipc, zod, strictObject, validation, image-generation, session-id

### Slack url_private URLs require Authorization header — plain fetch fails silently
**Date:** 2026-02-25
**Context:** Debugging why Slack image attachments resulted in "I don't see any image" from the LLM
**Lesson:** Slack's `url_private` URLs (returned in file attachment objects) require `Authorization: Bearer <bot_token>` to download. A plain `fetch(url)` returns 401/302, and if the download failure is caught+continued (like in buildContentWithAttachments), the image is silently dropped. Any channel provider that has authenticated URLs needs a `downloadAttachment` method to handle auth — don't put auth knowledge in the generic download pipeline.
**Tags:** slack, url_private, authentication, image-attachments, silent-failure
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

### Tool filtering must align with prompt module shouldInclude()
**Date:** 2026-02-26
**Context:** Added context-aware tool filtering — scheduler tools excluded when no heartbeat. Pi-session test broke because it expected scheduler tools without providing a HEARTBEAT.md file.
**Lesson:** When adding tool filtering by category, ensure the filter flags derive from the same data that prompt modules use in `shouldInclude()`. If HeartbeatModule checks `identityFiles.heartbeat?.trim()`, the scheduler filter must check the same thing. Test fixtures must provide the relevant identity files (e.g., HEARTBEAT.md in agentDir) when expecting those tools to be present.
**Tags:** tools, filtering, prompt-modules, testing, heartbeat

### claude-code.ts should use shared buildSystemPrompt() like other runners
**Date:** 2026-02-26
**Context:** claude-code.ts manually duplicated prompt building logic (importing PromptBuilder, loadIdentityFiles, loadSkills directly). Refactoring it to use shared buildSystemPrompt() from agent-setup.ts simplified the code and gave it the toolFilter for free.
**Lesson:** When all runners need the same derived data (system prompt + filter context), use the shared `buildSystemPrompt()` from agent-setup.ts. Don't duplicate the prompt-building logic in individual runners. If a runner needs custom prompt context fields, extend AgentConfig rather than reimplementing.
**Tags:** runners, claude-code, prompt, agent-setup, refactoring

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

### claude-code runner discards non-text content blocks — must extract and forward via SDKUserMessage
**Date:** 2026-02-26
**Context:** Images from Slack were downloaded correctly and passed to the agent as `image_data` ContentBlocks, but the claude-code runner stripped them to text-only
**Lesson:** The `runClaudeCode()` runner filters `config.userMessage` to text-only (`b.type === 'text'`), then passes a plain string to the Agent SDK `query()`. To forward images, extract `image_data` blocks separately, build an `SDKUserMessage` with `MessageParam.content` containing both `TextBlockParam` and `ImageBlockParam` entries, and pass as `AsyncIterable<SDKUserMessage>` to `query()`. The `ImageBlockParam.source` uses `{ type: 'base64', media_type, data }` matching Anthropic's `Base64ImageSource`. Note: the `media_type` field must be a literal union type, not `string` — cast `ImageMimeType as AnthropicMediaType`.
**Tags:** claude-code, agent-sdk, images, SDKUserMessage, ImageBlockParam, vision

### Mock LLM provider doesn't echo model names — use provider failures to verify routing
**Date:** 2026-02-26
**Context:** Writing tests for task-type model routing in the LLM router. Tried to verify which model chain was used by checking the mock provider's response text, but it returns static "Hello from mock LLM." regardless of model name.
**Lesson:** To test that the router selects the correct model chain for a task type, set the "wrong" chain to a provider that will fail (e.g., `openai/gpt-4` without API key) and the "right" chain to mock. If routing is correct, the call succeeds; if wrong, it throws. This is more robust than trying to inspect response content.
**Tags:** testing, llm-router, mock-provider, task-type-routing

### OpenRouter image generation uses /chat/completions, not /images/generations
**Date:** 2026-02-26
**Context:** User got a 404 HTML page when generating images via OpenRouter. The `openai-images.ts` provider was hitting `/api/v1/images/generations`, which doesn't exist on OpenRouter.
**Lesson:** OpenRouter, Gemini, and OpenAI each use different endpoints and request/response formats for image generation. OpenRouter uses `/chat/completions` with `modalities: ["image", "text"]` and returns images in `message.images[].image_url.url` as data URLs. Don't assume all providers implement the same image generation API — check their docs. Each distinct API shape needs its own provider implementation.
**Tags:** openrouter, image-generation, api-endpoints, provider-differences

### Slack file upload: use SDK's files.uploadV2(), not manual 3-step flow
**Date:** 2026-02-26
**Context:** Manual 3-step Slack file upload (getUploadURLExternal → HTTP PUT → completeUploadExternal) silently failed — files uploaded but not shared to channel (mimetype: "", shares: {}, channels: []).
**Lesson:** Slack's upload URL expects HTTP POST, not PUT. Using PUT causes the file to be created but not properly processed — no mimetype detection, no channel sharing. This is a known issue (bolt-js #2326). Always use the Slack SDK's `files.uploadV2()` method instead of implementing the 3-step flow manually. It handles POST correctly and wraps the entire flow. Use `initial_comment` to combine text + file as a single message.
**Tags:** slack, file-upload, uploadV2, http-method, put-vs-post

### AX has two workspace directories — session sandbox vs enterprise user
**Date:** 2026-02-26
**Context:** After migrating file storage from session workspace to enterprise user workspace
**Lesson:** AX has TWO distinct workspace directories:
1. **Session workspace** (`~/.ax/data/workspaces/<session-id-path>/`) — agent sandbox CWD, where agents can write files directly during execution. Ephemeral, tied to session ID.
2. **Enterprise user workspace** (`~/.ax/agents/<name>/users/<userId>/workspace/`) — durable per-user storage. Used for file uploads/downloads, generated image persistence, and `/v1/files/` API. Keyed by agent name + user ID.
After the migration, images are persisted to the **enterprise user workspace** and served via `?agent=<name>&user=<id>` query params. The session workspace remains as the sandbox CWD for agent execution.
**Tags:** workspaces, paths, session-id, images, file-api, enterprise

### IPC defaultCtx.agentId is 'system', not the configured agent name
**Date:** 2026-02-26
**Context:** Image resolver in ipc-handlers/llm.ts used `ctx.agentId` to look up images in user workspace, but images were persisted under `agentName` (typically 'main'). The resolver was looking in `~/.ax/agents/system/users/{user}/workspace/` instead of `~/.ax/agents/main/users/{user}/workspace/`.
**Lesson:** The IPC server's `defaultCtx` has `agentId: 'system'` — this is a fixed global context, not per-request. Any IPC handler that needs the configured agent name (from `config.agent_name`) must receive it as a separate parameter, NOT from `ctx.agentId`. The `agentName` is available in `createIPCHandler` scope and should be threaded through to any handler that needs it. The `_sessionId` injection mechanism only overrides `sessionId`, not `agentId`.
**Tags:** ipc, defaultCtx, agentId, image-resolver, workspace, enterprise

### Plugin providers use a runtime Map, not the static _PROVIDER_MAP
**Date:** 2026-02-27
**Context:** Implementing plugin framework — needed to register third-party providers at runtime without modifying the static allowlist (which would violate SC-SEC-002).
**Lesson:** Plugin-provided providers are stored in a separate `_pluginProviderMap` (Map), not in the `_PROVIDER_MAP` const. `resolveProviderPath()` checks the static map first, then falls back to the plugin map. This preserves the security invariant: built-in providers are static and auditable, while plugin providers are runtime-registered only by the trusted PluginHost after integrity verification. Use `registerPluginProvider()` (not direct map mutation) to add entries, and it will reject any attempt to overwrite built-in providers.
**Tags:** provider-map, plugins, security, SC-SEC-002, allowlist

### Child process IPC for plugins: fork() + process.send(), not worker_threads
**Date:** 2026-02-27
**Context:** Choosing between worker_threads and child_process for plugin isolation in PluginHost.
**Lesson:** Use `child_process.fork()` for plugin isolation, not `worker_threads`. Fork gives proper process isolation (separate V8 heap, can be sandboxed with nsjail), while workers share memory. The IPC protocol is simple: JSON messages over the built-in Node IPC channel (process.send/process.on('message')). Plugin sends `plugin_ready` on startup, host sends `plugin_call` with credentials injected server-side, plugin responds with `plugin_response`. This mirrors the agent↔host IPC pattern already used in AX.
**Tags:** plugins, plugin-host, isolation, child-process, ipc

### Adding IPC schemas without handlers causes ipc-server tests to fail
**Date:** 2026-02-27
**Context:** Added `plugin_list` and `plugin_status` IPC schemas in ipc-schemas.ts but forgot to create corresponding handlers. The ipc-server.test.ts has a sync test that verifies every schema has a handler.
**Lesson:** Every call to `ipcAction()` in ipc-schemas.ts MUST have a corresponding handler registered in ipc-server.ts. The sync test `every IPC_SCHEMAS action has a handler` catches this. Additionally, new internal-only IPC actions (not in tool catalog) must be added to `knownInternalActions` in tool-catalog-sync.test.ts. Checklist when adding new IPC schemas: (1) create handler in src/host/ipc-handlers/, (2) register in ipc-server.ts, (3) add to knownInternalActions if not agent-facing.
**Tags:** ipc, schemas, handlers, testing, sync-tests, plugins

### Always run full test suite before committing — targeted runs miss sync tests
**Date:** 2026-02-27
**Context:** Initial commit passed 53 new + 383 targeted tests, but CI caught 8 failures in agent/sync test files that weren't included in the targeted run.
**Lesson:** Always run `npm test -- --run` (full suite) before committing, not just the test files you touched. The tool-catalog-sync, sandbox-isolation, and ipc-server tests verify cross-module consistency (tool catalog ↔ MCP server ↔ IPC schemas ↔ handlers). These sync tests catch issues that per-module tests miss. Running only host/ tests after adding IPC schemas will miss the agent/ sync tests that verify those schemas have handlers.
**Tags:** testing, ci, sync-tests, full-suite, workflow

### Integration tests that spawn server processes need shared servers and long timeouts
**Date:** 2026-02-27
**Context:** Smoke tests timed out under full parallel CI load — 4 tests failed with empty stdout/stderr because tsx cold-start exceeded the 15s timeout when 167 test files ran simultaneously.
**Lesson:** When tests spawn child processes (e.g., `npx tsx src/main.ts`), the cold-start cost is high and unpredictable under parallel load. Three fixes: (1) Increase `waitForReady` timeout to 45s minimum — tsx cold-start under contention can easily take 20-30s. (2) Use event listeners on stdout/stderr instead of setInterval polling — react immediately when the readiness marker appears. (3) Share server processes across compatible tests using `beforeAll`/`afterAll` — reduces total spawn count and eliminates repeated cold starts. Tests sharing a server must use random session IDs to avoid state contamination.
**Tags:** testing, integration, flaky, timeout, child-process, shared-server, beforeAll

### Cross-provider imports should go through shared-types.ts, not sibling directories
**Date:** 2026-02-28
**Context:** Preparing provider extraction (Step 2b) — scheduler imported types directly from channel/, memory/, and audit/ directories
**Lesson:** When one provider category needs types from another (e.g., scheduler needs `SessionAddress` from channel), import from `src/providers/shared-types.ts` — never directly from `../channel/types.js`. This keeps the import graph clean for eventual package extraction. The shared-types file is purely re-exports; canonical definitions stay in their home provider's types.ts. A structural test in `tests/providers/shared-types.test.ts` enforces this by scanning source imports.
**Tags:** architecture, imports, providers, cross-provider, shared-types, extraction-prep

### Shared utilities between routers go in src/providers/router-utils.ts
**Date:** 2026-02-28
**Context:** image/router.ts was importing parseCompoundId from llm/router.ts — a cross-provider runtime dependency
**Lesson:** If multiple provider routers share utility functions (like `parseCompoundId`), extract them to `src/providers/router-utils.ts`. Don't have one router import from another — that creates a dependency between provider categories. When extracting the shared function, add a re-export from the original location for backwards compatibility, and mark it for removal in a future phase.
**Tags:** architecture, imports, router, shared-utils, parseCompoundId, extraction-prep

### EventBus should be optional and synchronous to avoid blocking the hot path
**Date:** 2026-02-28
**Context:** Implementing a streaming event bus for completion observability
**Lesson:** When adding cross-cutting observability to a request pipeline, make the bus synchronous (fire-and-forget) and optional (`eventBus?.emit()`). This way: (1) it never blocks the completion pipeline even if a listener is slow, (2) existing code paths work unchanged when no bus is wired in, (3) listener errors are isolated per-listener so one bad subscriber can't take down the pipeline. Use try/catch around each listener invocation, not around the emit loop.
**Tags:** event-bus, observability, architecture, performance, optional-dependency

### Use createHttpServer for isolated SSE endpoint tests instead of full AxServer
**Date:** 2026-02-28
**Context:** Needed to test the SSE /v1/events endpoint without the full server stack (providers, sandbox, IPC)
**Lesson:** For testing SSE endpoints, create a minimal HTTP server that implements just the endpoint logic with the real EventBus. This avoids the 5+ second startup cost of the full AxServer (provider loading, DB init, IPC server, template copying) and makes tests fast and isolated. The SSE endpoint only depends on the EventBus — no providers needed.
**Tags:** testing, sse, isolation, performance, event-bus

### Anthropic thinking deltas use 'thinking' key, not 'text'
**Date:** 2026-02-28
**Context:** Adding thinking/reasoning chunk support to the Anthropic LLM provider
**Lesson:** When processing Anthropic streaming events for extended thinking, the `content_block_delta` event's delta has a `thinking` key (not `text`). Cast delta to `Record<string, unknown>` to check for it since the SDK types may not include it yet. For OpenAI-compatible providers, reasoning content appears as `reasoning_content` or `reasoning` on the delta — also non-standard fields that need a cast to access.
**Tags:** anthropic, openai, thinking, reasoning, streaming, types
