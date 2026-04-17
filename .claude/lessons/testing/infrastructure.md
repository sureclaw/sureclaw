# Testing Infrastructure

## Lessons

### CommonJS container code in a type:module project needs a nested package.json override
**Date:** 2026-04-17
**Context:** Wrote a container-side module `container/git-server/install-hook.js` using `require()`/`module.exports` to match `http-server.js`. Vitest (repo is `type:module`) refused to load it via `createRequire` with "require is not defined in ES module scope."
**Lesson:** When you have a subdirectory that ships as CommonJS (e.g., a container's Node code that must stay dependency-free), drop a tiny `package.json` with `{"type": "commonjs"}` alongside the `.js` files. Node's resolver finds the nearest package.json and flips the module type back to CJS for just those files — tests can require them, the container runs them unchanged, no renames to `.cjs` required. The container had no enclosing package.json before, so it silently worked inside the image (defaults to CJS) but broke at test time.
**Tags:** commonjs, esm, package.json, type-module, container, require, vitest

### When merging split src/test branches, check 7 common failure patterns
**Date:** 2026-04-12
**Context:** Merging workspace-git-ssh-src (source changes) with workspace-git-ssh-tests (test branch) produced 10+ test failures.
**Lesson:** When source and tests are developed on separate branches, check these patterns: (1) renamed/moved provider directories (scanner -> security), (2) removed type fields (pvcName, workspaceSizeGi), (3) removed provider methods (deletePvc), (4) changed path constants (user/skills/ -> /workspace/skills/), (5) changed function signatures (new params, removed params), (6) changed mock requirements (new imports to mock), (7) source-reading tests that assert on deleted code patterns. Run the full suite first to identify all failures, then fix tests only — never modify source.
**Tags:** branch-merge, test-sync, provider-rename, path-change

### Don't call runMigrations() before createStorage() — it runs them internally
**Date:** 2026-03-31
**Context:** 20 tests failed with `SqliteError: no such column: "agent_id"` because test setup called `runMigrations(db, storageMigrations('sqlite'))` then `createStorage()` which runs migrations again with a different tracking table name (`storage_migration`). Migration 006 re-ran after 007 had already removed the column.
**Lesson:** Never call `runMigrations()` manually before `createStorage()`. The `create()` factory in `src/providers/storage/database.ts` runs migrations internally with its own tracking table. Calling it twice with different table names causes double-execution where later migrations' table changes confuse re-executed earlier migrations.
**Tags:** migrations, kysely, createStorage, double-migration, sqlite

### Module-level const from env var won't reflect runtime changes
**Date:** 2026-03-20
**Context:** CLAWHUB_API_URL env override didn't work because `const CLAWHUB_API = process.env.CLAWHUB_API_URL || '...'` is evaluated at module load time, not at call time.
**Lesson:** When an env var needs to be overridable at runtime (e.g., in tests that set env vars after import), use a getter function instead of a module-level const. `function clawHubApi() { return process.env.X || default; }` reads the env var each time it's called.
**Tags:** env-var, module-loading, testing, runtime-override

### NATS agents subscribe to sandbox.work queue group — never publish to agent.work.{podName}
**Date:** 2026-03-17
**Context:** K8s path E2E tests timed out because publishWork sent to `agent.work.{podName}` but agents subscribe to `sandbox.work` queue group.
**Lesson:** After the k8s networking simplification, agents always subscribe to `sandbox.work` (with tier-based queue group). The old per-pod subject `agent.work.{podName}` is dead — no agent listens on it. Always publish to `sandbox.work` in test harnesses. The `podName` parameter in `publishWork` is only used for the response (returned to caller), not for routing.
**Tags:** nats, k8s, sandbox, queue-group, publishWork, e2e

### Unix domain sockets don't work across Docker Desktop VM boundary on macOS
**Date:** 2026-03-17
**Context:** Docker E2E tests fail on macOS — agent inside Docker gets `ENOTSUP` connecting to host Unix socket mounted via volume.
**Lesson:** On macOS, Docker Desktop runs containers in a Linux VM. Volume-mounted Unix domain socket files appear in the container filesystem but connecting to them fails with `ENOTSUP` because the VM boundary doesn't support socket forwarding. This means the Docker sandbox provider's IPC via Unix socket only works on Linux (same kernel). On macOS, use either: (1) TCP-based IPC, (2) Apple container's `--publish-socket` bridge, or (3) NATS+HTTP IPC (the docker-nats test provider).
**Tags:** docker, macos, unix-socket, ipc, docker-desktop, vm-boundary, ENOTSUP

### K8s-mode server harness needs processCompletion directly — createServer lacks k8s wiring
**Date:** 2026-03-17
**Context:** Built k8s-server-harness.ts to wire up NATS publishWork + HTTP IPC for tests. The standard server-harness.ts uses createServer() from server.ts which doesn't support publishWork, agentResponsePromise, /internal/ipc, or token registry.
**Lesson:** `server.ts` (createServer) builds `completionDeps` internally without k8s-mode fields. `host-process.ts` adds them per-turn. For tests needing k8s mode, use `processCompletion()` directly with per-turn deps (following the run-http-local.ts pattern), not createServer(). The k8s-server-harness provides this as a reusable test fixture.
**Tags:** testing, k8s, harness, processCompletion, server, nats, ipc

### Agent stdin payload must parse ALL fields — missing fields cause silent feature loss
**Date:** 2026-03-13
**Context:** Running workspace acceptance tests, found workspace_mount tool never registered because workspaceProvider field not parsed from stdin payload in src/agent/runner.ts parseStdinPayload().
**Lesson:** When adding a new field to the stdin payload (passed from host to agent), you must update THREE places: (1) StdinPayload type definition, (2) parseStdinPayload() extraction logic, (3) main entry point field mapping from payload to AgentConfig. Missing any one silently drops the field and breaks features that depend on it. The symptom is always "feature works in structural tests but not at runtime."
**Tags:** agent, runner, stdin, payload, workspace, silent-failure

### K8s acceptance tests require multiple workarounds for single-process mode
**Date:** 2026-03-05
**Context:** Running plainjob scheduler and memoryfs-v2 acceptance tests in k8s kind cluster
**Lesson:** The Helm chart deploys `host-process.ts` which delegates to NATS/agent-runtime — it cannot process completions alone. For acceptance tests, override the command to `node dist/cli/index.js serve --port 8080` (compiled JS, not tsx). Also set `BIND_HOST=0.0.0.0` (CLI serve binds to 127.0.0.1 by default, breaking k8s probes). Never use tsx for the host command — dev mode causes agent subprocess spawns to fail because symlink-mount sandboxes can't resolve the tsx ESM loader path. The Helm chart also lacks a PVC for the data directory, so scheduler.db and other SQLite DBs are lost on pod restart. Inject API keys directly as env vars (`kubectl set env`).
**Tags:** k8s, acceptance, kind, helm, workarounds, bind-host, tsx, pvc

### K8s-pod sandbox requires NATS IPC bridge — use subprocess sandbox for now
**Date:** 2026-03-05
**Context:** Running memoryfs-v2 acceptance tests on k8s, k8s-pod sandbox pods created but agent couldn't communicate with host
**Lesson:** The k8s sandbox provider (`src/providers/sandbox/k8s.ts`) creates pods that need IPC to the host for LLM calls. The agent runner always uses Unix socket IPC (`--ipc-socket`), which only works when host and agent share a filesystem (same machine or pod). In k8s, sandbox pods are separate — the socket doesn't exist there. `src/agent/nats-bridge.ts` exists but isn't wired into runners. For acceptance tests, use `sandbox: subprocess` in kind-values.yaml — runs the agent as a child process in the host pod where IPC works. The k8s-pod sandbox also needs: `stdin: true` on the container spec + k8s Attach API for stdin/stdout piping, `pods/attach` RBAC permission on the sandbox-manager role, and `LOG_LEVEL=warn` to suppress pino logs that pollute pod stdout (which becomes the HTTP response).
**Tags:** k8s, sandbox, ipc, nats-bridge, subprocess, acceptance

### Helm chart injects API credentials only into agent-runtime, not host
**Date:** 2026-03-05
**Context:** Host pod in all-in-one mode returned empty LLM responses — OPENROUTER_API_KEY was missing
**Lesson:** The Helm chart's `apiCredentials` (OPENROUTER_API_KEY, DEEPINFRA_API_KEY etc.) are only injected into the `agent-runtime/deployment.yaml` template, not the `host/deployment.yaml`. In all-in-one server mode (where host also runs agents), add them via `--set-json 'host.env=[...]'` with `valueFrom.secretKeyRef`. The full helm command for acceptance tests:
```
--set-json 'host.env=[{"name":"BIND_HOST","value":"0.0.0.0"},{"name":"OPENROUTER_API_KEY","valueFrom":{"secretKeyRef":{"name":"ax-api-credentials","key":"openrouter-api-key"}}},{"name":"DEEPINFRA_API_KEY","valueFrom":{"secretKeyRef":{"name":"ax-api-credentials","key":"deepinfra-api-key"}}}]'
```
**Tags:** helm, credentials, k8s, acceptance, api-keys

### kind-values.yaml must include full config block to override chart defaults
**Date:** 2026-03-05
**Context:** Host pod crashed with ECONNREFUSED to PostgreSQL — chart defaults had `storage: postgresql`
**Lesson:** The `charts/ax/values.yaml` defaults include `storage: postgresql` and other production settings. The `kind-values.yaml` fixture must include a complete `config:` block to override ALL config values, not just a partial overlay. Without it, the host tries to connect to PostgreSQL which doesn't exist in the kind cluster. Always verify the rendered config with `helm template ... | grep -A 50 'ax.yaml'`.
**Tags:** helm, kind, config, postgresql, acceptance

### Avoid tokens with ! character in acceptance test configs (zsh history expansion)
**Date:** 2026-03-05
**Context:** Webhook acceptance tests failed with 401 because zsh escaped `!` to `\!` in curl headers
**Lesson:** zsh's history expansion treats `!` specially even in some quoting contexts. When setting tokens in `ax.yaml` for acceptance tests, avoid `!` and other shell-special characters (`$`, backticks). The token `acceptance-test-webhook-token-32chars!` silently became `acceptance-test-webhook-token-32chars\!` in curl headers, causing timing-safe comparison to fail. Use alphanumeric-only tokens for test fixtures. If you must use special chars, write the curl command to a script file instead of inline shell.
**Tags:** acceptance, zsh, shell-escaping, tokens, webhooks, auth

### Use curl -d @file for multi-turn JSON payloads in acceptance tests
**Date:** 2026-03-05
**Context:** IT-1 acceptance test appeared to fail — curl returned empty response for multi-turn conversation
**Lesson:** The Bash tool's shell can mangle inline JSON in `curl -d '...'` arguments, producing invalid escape sequences the server rejects with HTTP 400. `curl -sf` silently hides 400 errors (returns empty, exit code 22). Always write JSON payloads to a temp file and use `curl -d @/tmp/file.json`. When debugging empty curl responses, use `curl -v` (verbose) instead of `-sf` (silent+fail).
**Tags:** acceptance, curl, json, shell-escaping, debugging

### Bitnami PostgreSQL subchart image tags must be fully qualified
**Date:** 2026-03-05
**Context:** K8s acceptance test PostgreSQL pod stuck in ImagePullBackOff with `bitnami/postgresql:17`
**Lesson:** The Bitnami PostgreSQL subchart defaults to a fully qualified image tag like `17.6.0-debian-12-r4`. When overriding `postgresql.image.tag` in kind-values.yaml, short tags like `"17"` don't exist in Bitnami's registry. Either: (1) don't override the tag (let the subchart default apply), (2) use the exact tag from the subchart's values.yaml, or (3) pre-pull and tag the image locally (`docker tag bitnami/postgresql:latest bitnami/postgresql:17 && kind load docker-image ...`). For kind clusters, option (1) is safest but requires internet access during the pull.
**Tags:** k8s, helm, postgresql, bitnami, image-tag, kind, acceptance

### Tool count tests are scattered across many test files
**Date:** 2026-02-26
**Context:** Adding skill_import and skill_search tools caused failures in 5 different test files
**Lesson:** When adding new IPC tools, expect to update hardcoded tool counts in: tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts, and tests/agent/tool-catalog-sync.test.ts. Search for the old count (e.g. "25") across all test files before committing.
**Tags:** tools, testing, ipc, tool-catalog

### Adding a new tool category requires updating ToolFilterContext in test filter objects
**Date:** 2026-03-13
**Context:** Added workspace_scopes category with hasWorkspaceScopes filter. Updated 12 test files with workspace mocks but missed 3 files (sandbox-isolation, mcp-server, tool-catalog) that had hardcoded expected tool lists and filter context objects.
**Lesson:** When adding a new tool category with a new ToolFilterContext boolean field, update ALL of these: (1) expected tool name arrays in tests/sandbox-isolation.test.ts, tests/agent/mcp-server.test.ts, tests/agent/tool-catalog.test.ts; (2) hardcoded tool count `.toBe(N)` assertions; (3) explicit `filter: { ... }` objects in mcp-server.test.ts — these must include the new boolean field. Search: `grep -r 'hasWorkspace\|hasHeartbeat\|hasSkills\|hasGovernance' tests/` to find all filter context instances.
**Tags:** tools, testing, tool-catalog, ToolFilterContext, filter, mcp-server

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

### Mock provider registries must include all sub-providers accessed at handler construction time
**Date:** 2026-03-13
**Context:** Migrating identity handlers from filesystem to DocumentStore caused 211 test failures. The handler now accesses `providers.storage.documents` in its constructor (not just at call time). All mock registries across 8+ test files lacked a `storage` property.
**Lesson:** When a handler accesses a provider sub-property at construction time (e.g., `const documents = providers.storage.documents` in the factory function body), every mock registry that creates that handler must include that sub-property. Search for ALL test files that call the handler factory (or `createIPCHandler`) and add the required mock. The pattern is: `storage: { documents: createMockDocumentStore(), messages: {} as any, conversations: {} as any, sessions: {} as any, close() {} }`.
**Tags:** testing, mocks, providers, storage, constructor-time-access, blast-radius

### When migrating writes from filesystem to a store, update ALL read-back helpers in tests
**Date:** 2026-03-13
**Context:** After migrating `identity_write` to DocumentStore, e2e scenario tests failed because `harness.readIdentityFile()` still read from filesystem. The writes went to DocumentStore but the assertions checked filesystem.
**Lesson:** When migrating a write path from filesystem to a different store (DB, DocumentStore, etc.), search for ALL test helpers and assertions that read back the written data. In particular, check e2e harness helpers, integration test utilities, and any custom read functions. The write-side migration is only half the job — the read-side verification in tests must also be updated. Use `grep -r 'readIdentityFile\|readFileSync.*SOUL\|readFileSync.*IDENTITY' tests/` to find all read-back sites.
**Tags:** testing, migration, filesystem-to-db, e2e, harness, readIdentityFile

### Always disable pino file transport in tests that set AX_HOME to a temp dir
**Date:** 2026-03-01
**Context:** The phase1 integration test set `AX_HOME` to a temp dir, called `loadProviders()`, then deleted the temp dir. Pino's async worker thread raced with the cleanup and threw an unhandled ENOENT for `data/ax.log`.
**Lesson:** When a test sets `AX_HOME` to a temp directory and loads providers or any code that triggers `getLogger()`, always call `initLogger({ file: false, level: 'silent' })` before the code under test, and `resetLogger()` in the `finally` block. Module-level `getLogger()` calls in provider modules (e.g. `llm/router.ts`) will create the singleton on first import.
**Tags:** testing, pino, logger, AX_HOME, race-condition, cleanup
