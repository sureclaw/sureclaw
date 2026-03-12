# Testing Infrastructure

### Provider-map path regex tests must allow hyphens in category directory names
**Date:** 2026-03-12
**Context:** Adding workspace-sync provider with hyphenated directory name broke path format tests
**Lesson:** When adding a new provider category with a hyphenated name (e.g. `workspace-sync`), update the provider-map path regex in both `tests/host/provider-map.test.ts` and `tests/integration/phase2.test.ts`. The regex for the category directory segment should be `[a-z][a-z0-9-]*` not `[a-z]+`.
**Tags:** provider-map, regex, test-fix, naming

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
