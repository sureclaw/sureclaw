# Testing: Acceptance

Acceptance test skill and framework for validating features against plan design goals.

## [2026-03-17 08:42] — E2E test of k8s networking simplification (HTTP IPC) via ax-debug harness

**Task:** Test the k8s networking simplification plan (docs/plans/2026-03-17-k8s-networking-simplification.md) end-to-end using the HTTP IPC local debug harness.
**What I did:** Started nats-server, launched `run-http-local.ts` harness, sent two chat completion requests via curl, verified health endpoint and token security (401 for invalid tokens).
**Files touched:** None (read-only testing)
**Outcome:** SUCCESS. Full HTTP IPC flow confirmed working:
  1. Host published work via NATS `sandbox.work` queue group (with retry — agent needed 2 attempts to subscribe)
  2. Agent subprocess received work via NATS, processed with `HttpIPCClient`
  3. Agent sent `llm_call` IPC via HTTP POST to `/internal/ipc` with Bearer token auth
  4. Agent sent `agent_response` via HTTP IPC, host returned completion
  5. Second request also succeeded (stability under repeated use)
  6. Invalid token correctly returned 401 (security check)
  7. Health endpoint returned `{"status":"ok"}`
**Notes:** The plan's Tasks 1-9 appear fully implemented. NATS files (nats-ipc-client.ts, nats-bridge.ts, nats-ipc-handler.ts, nats-llm-proxy.ts) and warm-pool-client.ts are already deleted. HttpIPCClient and llm-proxy-core.ts exist. The HTTP IPC harness (`run-http-local.ts`) is a complete standalone test of the new architecture.

## [2026-03-13 13:46] -- K8s acceptance: workspace provider

**Task:** Deploy AX to kind cluster with workspace provider enabled and run all behavioral (BT-1 through BT-5) and integration tests (IT-1 through IT-3) for the workspace feature.
**What I did:** Deployed with `workspace: local`, ran all 8 non-structural tests. Discovered and fixed two bugs: (1) `parseStdinPayload()` didn't extract `workspaceProvider` from JSON, (2) main runner didn't assign `payload.workspaceProvider` to `config.workspaceProvider`. Both fixes in `src/agent/runner.ts`. Created separate namespace for BT-3 (workspace: none). Redeployed with maxFileSize=100 for BT-4.
**Files touched:** `src/agent/runner.ts` (2 bug fixes), `tests/acceptance/workspace/results-k8s.md` (created)
**Outcome:** Partial success. 4/8 passed, 2/8 partial pass, 2/8 failed. Failures are architectural: workspace_write IPC handler bypasses the provider commit pipeline (no maxFileSize or ignore pattern enforcement). Partial passes due to per-request session IDs in k8s mode breaking additive scope tracking.
**Notes:** The workspace feature has two independent write paths: enterprise two-tier (workspace_write) and provider-backed (workspace_mount/commit). Only the provider-backed path enforces structural checks. The k8s NATS architecture creates separate internal request IDs per HTTP call, which breaks in-memory scope tracking across requests within the same persistent session.

## [2026-03-06 17:15] -- K8s acceptance: verify cortex infrastructure fixes (FIX-10/11/12)

**Task:** Deploy AX to kind cluster with custom PG username "ax" and verify 3 infrastructure fixes work automatically: pgvector auto-enabled (FIX-10), custom user/database created (FIX-11), advisory lock prevents duplicate backfill (FIX-12). Run BT-8, IT-7, IT-8.
**What I did:** Deployed via Helm with `postgresql.internal.auth.username=ax` + `postgresql.auth.username=ax` + `postgresql.auth.password=ax-test-password`. Verified pgvector extension installed (owned by postgres superuser). Verified "ax" user exists with LOGIN + CREATEDB, owns all 20 tables. Inserted 3 items without embeddings, restarted both pods simultaneously — host got the advisory lock and backfilled, agent-runtime logged `backfill_skipped`. All 3 behavioral tests passed.
**Files touched:** `tests/acceptance/cortex/results-k8s-fixes.md` (created)
**Outcome:** Success. All 3 fixes verified, all 3 behavioral tests pass. Key finding: `ax k8s init` must set both `postgresql.internal.auth.username` AND `postgresql.auth.username`/`password` (Bitnami subchart level) for custom usernames to work.
**Notes:** First attempt failed because reused PVC from previous install had stale passwords. Had to delete namespace entirely and start fresh. Also: Bitnami subchart only creates `password` secret key when `auth.password` is explicitly set — without it, host pod gets `CreateContainerConfigError`.

## [2026-03-06 23:00] -- Fix 3 k8s infrastructure gaps from cortex re-test

**Task:** Fix 3 infrastructure gaps identified in the cortex k8s re-test: (1) pgvector not auto-enabled, (2) custom PG user/database not reliably created, (3) dual cortex instances run duplicate backfills
**What I did:** Created `charts/ax/templates/postgresql-init-job.yaml` — Helm hook Job (post-install/post-upgrade, weight=1) that connects as postgres superuser, enables pgvector, and optionally creates custom user/database when non-postgres username is configured. Added PostgreSQL advisory lock to `backfillEmbeddings()` in `src/providers/memory/cortex/provider.ts` so only one process runs the backfill when sharing a database. Added `initImage` field to values.yaml for the pg-init job.
**Files touched:** `charts/ax/templates/postgresql-init-job.yaml` (created), `charts/ax/values.yaml` (modified), `src/providers/memory/cortex/provider.ts` (modified), `tests/acceptance/cortex/fixes.md` (updated)
**Outcome:** Success. Build passes, all 2359 tests pass. Helm template renders correctly for both postgres and custom user cases, and is skipped for external PostgreSQL.
**Notes:** The advisory lock key (0x41585F4246) is "AX_BF" encoded as an integer. The lock is session-scoped so it auto-releases if the process crashes.

## [2026-03-06 22:00] -- Cortex Memory K8s re-test (22/23 PASS, 1 SKIP)

**Task:** Re-run the 7 non-PASS tests from the previous k8s cortex run (BT-6, BT-7, BT-8, BT-11, BT-12, IT-7, IT-8) after applying FIX-6 through FIX-9
**What I did:** Deployed to kind cluster (ns: ax-test-cortex-retest-545d544b). Key infrastructure fix: pgvector 0.8.2 was available in Bitnami PostgreSQL image but not enabled -- installed via `CREATE EXTENSION vector`. Also patched PG secret (missing `password` key) and created `ax` user/database manually. After pgvector install, restarted both host and agent-runtime pods. Ran all 7 tests sequentially via chat API.
**Files touched:** `tests/acceptance/cortex/results-k8s-retest.md` (created)
**Outcome:** 6/7 now PASS, 1 SKIP (BT-7, structural limitation). Combined with previous run: 22/23 PASS, 1 SKIP. Key findings: (1) pgvector works out of the box in Bitnami PG 17 once enabled, (2) both host AND agent-runtime have independent cortex provider instances with separate backfill, (3) write-time embedding works with pgvector, (4) semantic cross-session recall confirmed working, (5) backfill covered all 24 items (100%).
**Notes:** BT-7 (LLM extraction failure) remains SKIP -- cannot trigger LLM failure via chat endpoint, this is a unit test concern. Three infra gaps remain: pgvector not auto-enabled by chart, PG user/database not created by Bitnami subchart, secret missing `password` key.

## [2026-03-06 20:30] -- Cortex Memory K8s-only acceptance tests (16/23 PASS, 5 SKIP, 2 PARTIAL)

**Task:** Run k8s-only cortex acceptance tests (no local, no structural)
**What I did:** Built Docker image, loaded into kind, spawned k8s agent. Agent deployed to ns ax-test-cortex-41c38415, ran 12 BT + 11 IT tests. Had to manually patch host deployment for API creds and fix PG auth.
**Files touched:** `tests/acceptance/cortex/results-k8s.md` (overwritten), `tests/acceptance/cortex/fixes.md` (updated with FIX-6 through FIX-9)
**Outcome:** 16/23 PASS, 5 SKIP, 2 PARTIAL. Same pattern as previous k8s run. Four new fix items: (1) FIX-6 host deployment missing API creds, (2) FIX-7 sqlite-vec missing from image, (3) FIX-8 keyword LIKE bug, (4) FIX-9 PG auth mismatch.
**Notes:** Core memory CRUD, dedup, reinforcement, summaries, pod restart persistence all work. Gaps are infra (chart/image) and one code bug (keyword search).

## [2026-03-06 15:40] -- Cortex Memory K8s acceptance tests rerun (16/23 PASS, 5 SKIP, 2 PARTIAL)

**Task:** Run behavioral and integration acceptance tests for cortex memory provider on K8s/kind cluster with PostgreSQL storage (rerun after ef6da27)
**What I did:** Deployed AX to kind cluster (ns: ax-test-cortex-41c38415). Fixed PostgreSQL auth (Bitnami subchart missing ax user password), patched host deployment to inject API credentials. Ran all 12 BT and 11 IT tests sequentially via chat API.
**Files touched:** `tests/acceptance/cortex/results-k8s.md` (results overwritten)
**Outcome:** 16 PASS, 5 SKIP (untestable via chat: BT-6 taint, BT-7 LLM failure, BT-8/BT-12 embedding, BT-11 summary ID rejection, IT-8 backfill), 2 PARTIAL (IT-7 recall limited by sqlite-vec absence + keyword LIKE bug). Key findings: (1) Chart needs API credentials on host deployment, not just agent-runtime. (2) Bitnami subchart needs explicit auth.password. (3) sqlite-vec missing from container image breaks embedding recall. (4) searchContent LIKE bug: OR-joined terms treated as literal string.
**Notes:** Summaries in PostgreSQL (DbSummaryStore) work correctly. Pod restart preserves all data. Dedup and reinforcement verified. 10 default categories initialized.

## [2026-03-06 18:30] -- Cortex Memory K8s acceptance tests (15/23 PASS, 3 DEGRADED, 3 SKIP, 2 PARTIAL)

**Task:** Run behavioral and integration acceptance tests for cortex memory provider on K8s/kind cluster with PostgreSQL storage
**What I did:** Deployed AX to kind cluster with PostgreSQL, NATS eventbus, subprocess sandbox. Fixed migration ordering bug (DbSummaryStore.initDefaults called before CREATE TABLE). Ran all 12 BT and 11 IT tests sequentially via chat API.
**Files touched:** `src/providers/memory/cortex/provider.ts` (migration ordering fix), `tests/acceptance/cortex/results-k8s.md` (results)
**Outcome:** 15 PASS, 3 DEGRADED (embedding service 401), 3 SKIP (untestable), 2 PARTIAL (tool schema limitations). Key finding: DbSummaryStore works correctly with PostgreSQL, summaries survive pod restarts, content hash dedup works cross-dialect.
**Notes:** DeepInfra embedding API key was a placeholder (401). All embedding-dependent tests degraded gracefully. Found and fixed migration ordering bug that caused crash-loop on k8s.

## [2026-03-06 12:42] -- Cortex Memory local acceptance tests re-run (48/51 PASS, 1 SKIP)

**Task:** Re-run all 51 cortex memory acceptance tests (31 ST, 12 BT, 11 IT) including new summary storage tests
**What I did:** Set up isolated AX_HOME, ran 31 structural tests by reading source files. Started server with `providers.memory: cortex` and deepinfra embedding model (Qwen3-Embedding-0.6B). Ran behavioral tests BT-1/2/4/9/10 via chat, structural verification for BT-3/5/6/8/11/12. Ran integration tests IT-1/3/4/7/9/10/11 live, IT-2/5/6/8 structurally. Server restart test (IT-9) confirmed summaries survive. BT-7 skipped (cannot inject LLM failures via CLI).
**Files touched:** `tests/acceptance/cortex/results-local.md` (overwritten)
**Outcome:** 48/51 PASS, 2 structural-only verifications, 1 SKIP. All new summary storage tests (ST-25/26/27/28, BT-10/11/12, IT-9/10/11) pass. Cross-session semantic recall works with embedding strategy. Deduplication and reinforcement working correctly. User-scoped summaries stored in `data/memory/users/<userId>/`.
**Notes:** Content hash deviation persists (type-agnostic, no `{type}:` prefix). Provider renamed from memoryfs to cortex. DEV-1 (read-path reinforcement) and DEV-4 (read doesn't reinforce) still not implemented. Explicit writes get reinforcement=10 (DEV-2). Summary files contain coherent LLM-synthesized content, not raw concatenation.

## [2026-03-05 22:18] -- K8s Agent Compute full k8s acceptance tests (26/26 PASS)

**Task:** Run all 26 k8s-dependent acceptance tests (8 HT, 8 KT, 6 IT, 4 SEC) for k8s-agent-compute architecture on kind cluster
**What I did:** Generated unique namespace, created secrets, deployed Helm chart, fixed PostgreSQL image tag issue (bitnami/postgresql:17 not found, loaded :latest as :17), loaded ax/agent:test image into kind, waited for all pods, ran all tests sequentially. Tore down deployment after.
**Files touched:** `tests/acceptance/k8s-agent-compute/results-k8s.md` (created)
**Outcome:** 26/26 PASS. All Helm template, Kind cluster, integration, and security tests pass. The three-layer architecture (host/agent-runtime/pool-controller + sandbox pods) is fully functional with NATS communication, PostgreSQL persistence, network isolation, and hardened sandbox pods.
**Notes:** Key achievements: (1) IT-3 proves full tool dispatch flow: agent-runtime -> NATS claim -> sandbox pod -> tool execution -> NATS result -> agent-runtime. (2) IT-4 proves per-turn pod affinity: second tool call reuses same sandbox pod without re-claiming. (3) IT-6 proves conversation persistence across pod restarts via PostgreSQL. (4) SEC-1/2/3/4 prove complete sandbox isolation. One infrastructure issue: bitnami/postgresql:17 image tag didn't exist, needed manual loading. Heavy.json nodeSelector still has GKE-specific value due to Helm deep merge behavior.

## [2026-03-05 21:56] -- Skills Install Architecture local acceptance tests (24/24 PASS)

**Task:** Run all 24 skills-install acceptance tests (16 ST, 5 BT, 3 IT) against a local AX server
**What I did:** Set up isolated AX_HOME, ran 16 structural tests by reading source files (types, parser, bin-exists, ipc-schemas, handlers, ipc-server, tool-catalog, taint-budget, screener, manifest-generator, install-validator). Started server, created 5 test skills (test-install-skill, test-bin-warn-skill, test-lifecycle-skill, test-legacy-install, test-os-filter) in the git-backed skills directory. Ran 5 behavioral tests via direct IPC protocol calls: inspect, execute, token mismatch rejection, taint budget enforcement (structural), and missing-bin warnings on read. Ran 3 integration tests: full lifecycle, backward-compat old format, and OS filtering.
**Files touched:** `tests/acceptance/skills-install/results-local.md` (created)
**Outcome:** 24/24 PASS. All structural, behavioral, and integration tests pass. Two-phase install flow works end-to-end (inspect -> execute -> status). TOCTOU defense via inspectToken SHA-256 verified. Old kind/package format backward-compat verified. OS filtering correctly excludes non-matching platform steps on macOS.
**Notes:** LLM (Gemini Flash) did not reliably make skill_install tool calls, so behavioral tests used direct IPC binary protocol for determinism. The command prefix allowlisting correctly rejects `echo` as an invalid package manager prefix.

## [2026-03-05 21:50] -- Cortex Memory local acceptance tests (41/41 PASS)

**Task:** Run all 41 cortex (renamed from memoryfs) acceptance tests (27 ST, 9 BT, 8 IT) against a local AX server
**What I did:** Set up isolated AX_HOME, ran 27 structural tests by reading source files (types, migrations, content-hash, salience, summary-io, provider, extractor, prompts, embedding-store, memory-recall, server-completions, provider-map). Started server with `providers.memory: cortex`, deepinfra embedding model (Qwen3-Embedding-0.6B), ran 9 BTs and 8 ITs sequentially using `tsx src/cli/index.ts send` and direct SQLite queries.
**Files touched:** `tests/acceptance/cortex/results-local.md` (created)
**Outcome:** 41/41 PASS. All structural, behavioral, and integration tests pass. LLM extraction correctly identified preferences, dedup worked (reinforcement_count incremented), cross-session recall via embedding strategy confirmed, salience ranking verified mathematically.
**Notes:** Five plan deviations documented: (1) no read-path reinforcement, (2) explicit writes get reinforcement=10, (3) no summary search in read path, (4) read() doesn't reinforce, (5) content hash is type-agnostic (no `{type}:` prefix). Provider renamed from `memoryfs` to `cortex`. Embedding model uses deepinfra/Qwen not OpenAI.

## [2026-03-05 21:45] — LLM Webhook Transforms local acceptance tests (21/21 PASS)

**Task:** Run all 21 llm-webhook-transforms acceptance tests (12 ST, 5 BT, 4 IT) against a local AX server
**What I did:** Set up isolated AX_HOME, ran 12 structural tests by reading source files (config schema, types, paths, server-webhooks, webhook-transform, server wiring, docs). Started server with `webhooks.enabled: true`, ran 5 behavioral tests (push 202, watch 204, auth reject 401, missing transform 404, X-AX-Token auth). Restarted server with `allowed_agent_ids` for IT-2, then again for IT-3 rate limit test. Ran all 4 integration tests (full pipeline, allowlist enforcement, rate limiting, taint tagging).
**Files touched:** `tests/acceptance/llm-webhook-transforms/results-local.md` (created)
**Outcome:** 21/21 PASS. All structural, behavioral, and integration tests pass. LLM correctly returned null for ignored events (watch), correctly transformed push events, and the allowlist correctly blocked unauthorized agentIds.
**Notes:** zsh shell escaping of `!` in tokens caused auth failures until token was changed to avoid special characters. Rate limiter state is per-process, so server restarts were needed between IT-3 and IT-4. Unix socket connections resolve remoteAddress to `undefined`/`'unknown'`, making all requests share the same rate limit bucket.

## [2026-03-05 23:55] — K8s Agent Compute local acceptance tests (16/16 ST PASS, 26 SKIP)

**Task:** Run all 42 k8s-agent-compute acceptance tests in local environment
**What I did:** Set up isolated AX_HOME, started local server, verified health + agent responsiveness. Ran all 16 structural tests by reading source files -- all pass. Marked all 8 Helm Template, 8 Kind Cluster, 6 Integration, and 4 Security tests as SKIP (require k8s infrastructure). Verified Helm templates structurally by reading YAML source.
**Files touched:** `tests/acceptance/k8s-agent-compute/results-local.md` (created)
**Outcome:** 16 PASS, 0 FAIL, 26 SKIP. All code-shape tests confirm the three-layer architecture exists with correct interfaces, NATS protocols, security hardening, pool controller, and dual-mode IPC handlers.
**Notes:** Two naming deviations: (1) Sandbox provider is `k8s` in provider-map, not `k8s-pod` as test plan states. (2) Storage provider map has `{ file, database }` not `{ sqlite, postgresql }` -- the sqlite/postgresql split is at the database provider layer. Both are implementation refinements.

## [2026-03-05 21:46] — PlainJob Scheduler local acceptance tests (12/12 PASS)

**Task:** Run all 12 plainjob-scheduler acceptance tests (8 ST, 2 BT, 2 IT) against a local AX server
**What I did:** Set up isolated AX_HOME, ran 8 structural tests by reading source files, started server with `providers.scheduler: plainjob`, ran 2 behavioral tests (server start + DB creation), ran 2 integration tests (cron persistence across restart + one-shot run_at persistence). All tests pass.
**Files touched:** `tests/acceptance/plainjob-scheduler/results-local.md` (created)
**Outcome:** 12/12 PASS. Server starts cleanly with plainjob scheduler, scheduler.db created with correct schema (cron_jobs table, WAL mode), cron jobs persist across server restart, one-shot jobs retain run_at timestamps after restart.
**Notes:** Two naming deviations from the original plan: (1) Store class is `KyselyJobStore` in `src/job-store.ts` instead of `SQLiteJobStore` in `types.ts` -- supports shared DatabaseProvider injection. (2) Table is named `cron_jobs` instead of `scheduler_jobs`. Both are refinements, not defects.

## [2026-03-05 23:30] — Implement plainjob-scheduler acceptance test fixes

**Task:** Implement 4 fixes from tests/acceptance/plainjob-scheduler/fixes.md
**What I did:**
- FIX-1: Enabled agent-runtime in kind-values.yaml (was false, blocking completions via NATS)
- FIX-2: Switched storage/audit to `database` with `database: postgresql` in both kind-values.yaml and ax-k8s.yaml (was file-based, lost on pod restart)
- FIX-3: Added `BIND_HOST: "0.0.0.0"` to host and agent-runtime Helm deployment templates (probes need pod IP, not localhost)
- FIX-4: Confirmed agent-runtime deployment already has apiCredentials rendered — no change needed
- Updated comments in both fixture files to reflect phase-2 architecture
**Files touched:** `tests/acceptance/fixtures/kind-values.yaml`, `tests/acceptance/fixtures/ax-k8s.yaml`, `charts/ax/templates/host/deployment.yaml`, `charts/ax/templates/agent-runtime/deployment.yaml`
**Outcome:** Success — all 4 fixes implemented. Build passes.
**Notes:** FIX-4 was already done in the agent-runtime template (lines 41-49). The ax-k8s.yaml sandbox was also updated from `k8s` to `subprocess` to match kind-values.yaml.

## [2026-03-05 22:00] — Switch k8s acceptance tests from SQLite to PostgreSQL

**Task:** Update acceptance test fixtures and skill to use PostgreSQL instead of SQLite for storage on k8s
**What I did:** Changed `storage: sqlite` → `storage: postgresql` in `kind-values.yaml` and `ax-k8s.yaml`. Added `postgresql.internal.enabled: true` to `kind-values.yaml` to deploy Bitnami PostgreSQL subchart in-cluster. Removed dummy `ax-db-credentials` secret from setup. Updated SKILL.md: provider comparison table, k8s setup (PG wait step, PG_POD variable), side-effect checking commands (psql for conversation DB), environment descriptions, results template, and tips.
**Files touched:** `tests/acceptance/fixtures/kind-values.yaml`, `tests/acceptance/fixtures/ax-k8s.yaml`, `.claude/skills/acceptance-test/SKILL.md`
**Outcome:** Success — k8s acceptance tests now use PostgreSQL for the storage provider, matching the chart's production defaults. Memory (memoryfs) and audit still use SQLite on the pod's local filesystem.
**Notes:** Audit provider only supports `file` and `sqlite` — no PostgreSQL option. The `ax-k8s.yaml` keeps `sandbox: k8s` as the ideal target; `kind-values.yaml` overrides to `subprocess` for practical use until NATS IPC bridge is integrated.

## [2026-03-05 21:04] — Skills Install k8s acceptance tests

**Task:** Run skills-install behavioral and integration tests against k8s AX server
**What I did:** Deployed test skills to k8s pod (required openclaw metadata format fix), patched host deployment for API key env vars, ran 7 tests (BT-1/2/3/5, IT-1/2/3) via direct IPC calls to host Unix socket. Also verified one end-to-end chat completions test. Checked audit log (23 entries) and state persistence (2 state files).
**Files touched:** `tests/acceptance/skills-install/results.md` (appended k8s results section)
**Outcome:** 7/7 PASS. All behavioral and integration tests pass in k8s. Skill metadata format required `metadata.openclaw` block (not top-level frontmatter). LLM model (Gemini Flash) intermittently used wrong parameter names for skill tool, requiring direct IPC testing approach.
**Notes:** Three setup issues discovered: (1) Skills must use `metadata.openclaw` nested block for `install`/`requires` fields, (2) API key secret not mounted in host deployment by default, (3) LLM model inconsistently names tool parameters (`name`/`skillName` vs `skill`). OS filtering correctly shows Linux+universal on k8s (vs macOS+universal locally).

## [2026-03-05 16:15] — MemoryFS v2 k8s acceptance tests

**Task:** Run memoryfs-v2 acceptance tests against k8s/kind environment
**What I did:** Deployed AX to kind cluster, resolved 10+ infrastructure issues, ran 41 tests
**Files touched:** `src/host/server.ts` (BIND_HOST), `src/providers/sandbox/k8s.ts` (LOG_LEVEL, stdin, Attach), `tests/acceptance/fixtures/kind-values.yaml` (full config block, subprocess sandbox), `tests/acceptance/memoryfs-v2/results-k8s.md` (new)
**Outcome:** 40/41 PASS, 1 SKIP (IT-8 backfill needs PVC). K8s-pod sandbox not functional with all-in-one server (IPC over Unix sockets doesn't cross pod boundaries, NATS bridge not integrated). Used subprocess sandbox as workaround.
**Notes:** Major k8s infrastructure gaps discovered: BIND_HOST for probes, API credentials only in agent-runtime template, kind-values.yaml missing full config block, k8s sandbox needs pods/attach RBAC. The k8s-pod sandbox requires NATS IPC bridge integration (Phase 3 work).

## [2026-03-05 15:40] — LLM Webhook Transforms k8s acceptance tests

**Task:** Re-run webhook transforms acceptance tests in k8s environment (previously 12/21 pass)
**What I did:** Built fresh Docker image with commit 107b074 (which wired webhook routes into host-process.ts). Deployed to kind cluster with webhook config. Ran all 9 behavioral/integration tests sequentially via curl through port-forward. Required workarounds: patched host deployment env vars for API keys (Helm chart only injects into agent-runtime), changed webhook token to avoid zsh `!` escaping, patched ConfigMap for IT-2 allowlist test.
**Files touched:** `tests/acceptance/llm-webhook-transforms/results-k8s.md` (updated), `tests/acceptance/fixtures/kind-values.yaml` (added webhooks config)
**Outcome:** 21/21 PASS. All behavioral/integration tests pass after commit 107b074 fixed the missing webhook routes in host-process.ts. Found 2 minor gaps: recordTaint not wired in k8s mode, Helm chart missing apiCredentials for host deployment.
**Notes:** Stale port-forwards from other namespaces caused intermittent 404s/401s — always kill ALL port-forwards before restarting.

## [2026-03-05 15:35] — PlainJob Scheduler k8s acceptance tests

**Task:** Re-run plainjob scheduler acceptance tests in k8s environment
**What I did:** Deployed AX to kind cluster, ran BT-1, BT-2, IT-1, IT-2 against a k8s pod. Required multiple workarounds: switched from host-process.ts to compiled CLI serve, set BIND_HOST=0.0.0.0, used compiled JS instead of tsx, injected API keys as env vars.
**Files touched:** `tests/acceptance/plainjob-scheduler/results-k8s.md` (created)
**Outcome:** 12/12 PASS — scheduler logic fully correct. Found 5 k8s infrastructure gaps (no PVC for data dir, host-process.ts requires agent-runtime, BIND_HOST default, tsx path resolution, no sqlite3 CLI).
**Notes:** Structural tests reused from local run. Integration tests tested within-pod SQLite persistence (close/reopen) since no PVC exists for cross-pod persistence. The scheduler actively fired jobs during the test.

## [2026-03-05 14:45] — Re-run MemoryFS v2 acceptance tests (commit 74b01ed)

**Task:** Re-run all 41 acceptance tests for MemoryFS v2
**What I did:** Set up isolated AX_HOME, ran 27 structural tests via parallel subagents, started server for behavioral/integration tests, ran 9 BTs and 8 ITs sequentially
**Files touched:**
- `tests/acceptance/memoryfs-v2/results.md` (overwritten with new results)
**Outcome:** 41/41 PASS. IT-1 initially appeared as PARTIAL PASS but root-caused to test harness bug (shell mangled inline JSON in curl `-d`). All structural, behavioral, and integration tests pass.
**Notes:** (1) Server auto-exits after idle (~26s), requiring restarts between test batches. (2) Use `curl -d @file` instead of inline `-d '...'` for multi-turn JSON payloads to avoid shell escaping issues. (3) `curl -sf` silently hides HTTP 400 errors — always check with `-v` when debugging empty responses.

## [2026-03-05 18:30] — Add dual-environment (local + k8s) support to acceptance test skill

**Task:** Extend the acceptance-test skill so the same BT/IT test plans run against both local and k8s (kind) environments
**What I did:** Created k8s fixture config and Helm overrides, updated local fixture with explicit provider fields, rewrote SKILL.md Phase 3 with environment selection, k8s setup/teardown, dual send/check abstractions, environment-specific results files, and added new provider source paths to Phase 4
**Files touched:**
- `tests/acceptance/fixtures/ax-k8s.yaml` (created — k8s-pod sandbox, nats eventbus, sqlite storage)
- `tests/acceptance/fixtures/kind-values.yaml` (created — simplified single-pod Helm overrides for kind)
- `tests/acceptance/fixtures/ax.yaml` (updated — added storage, eventbus, changed skills to git, scheduler to plainjob)
- `.claude/skills/acceptance-test/SKILL.md` (major update — environment selection, k8s lifecycle, provider comparison table, dual send/check commands, separate results files, environment field in fix list)
- `tests/acceptance/README.md` (rewritten — documents both environments, k8s setup, log tailing, directory structure)
**Outcome:** Success — all fixtures valid YAML, skill covers both flows end-to-end
**Notes:** K8s fixture uses `agentRuntime.enabled: false` and `poolController.enabled: false` since feature tests only need a single-process AX server, not the full 3-tier architecture. This is simpler and faster to deploy than k8s-agent-compute's setup.

## [2026-03-05 16:45] — Re-run skipped integration tests for k8s agent compute (IT-1/2/3/4/6)

**Task:** Re-run 5 integration tests that were skipped due to missing LLM API key
**What I did:** Set up OpenRouter API key in k8s secret, discovered and fixed 4 new issues (FIX-7 through FIX-10), ran all 5 skipped tests
**Files touched:**
- `charts/ax/templates/networkpolicies/agent-runtime-network.yaml` (added port 6443 egress)
- `charts/ax/templates/agent-runtime/deployment.yaml` (added K8S_RUNTIME_CLASS env var)
- `charts/ax/values.yaml` (added sandbox.runtimeClass)
- `tests/acceptance/k8s-agent-compute/kind-values.yaml` (runtimeClass: "")
- `src/host/agent-runtime-process.ts` (override sandbox to subprocess for agent loop)
- `src/providers/sandbox/k8s-pod.ts` (fix label sanitization)
- `tests/acceptance/k8s-agent-compute/results.md` (updated with results)
- `tests/acceptance/k8s-agent-compute/fixes.md` (added FIX-7 through FIX-10)
**Outcome:** 42/42 tests executed: 40 PASS, 2 PARTIAL, 0 FAIL, 0 SKIPPED
**Notes:** IT-3 and IT-4 are partial because tool dispatch goes through local subprocess, not NATS sandbox worker pods. The dispatch infrastructure exists but isn't wired into the IPC handler pipeline yet.

## [2026-03-03 21:51] — Acceptance tests for Skills Install Architecture (24 tests)

**Task:** Run acceptance tests at tests/acceptance/skills-install/test-plan.md
**What I did:** Ran 24 tests (16 structural, 5 behavioral, 3 integration). All structural tests passed by reading source files. Behavioral/integration tests used isolated AX_HOME with readonly skill provider and test skills. Had to fix skill path (must be `agents/main/agent/skills/`) and use valid package manager commands (command prefix allowlisting rejects `echo`).
**Files touched:**
- `tests/acceptance/skills-install/results.md` (new) — full results
**Outcome:** 23/24 passed, 1 skipped (BT-4 taint test requires complex setup). All core functionality works.
**Notes:** agentId defaults to 'system' in IPC context, not agent name. Skills must be in `agents/<name>/agent/skills/` for readonly provider.

## [2026-03-03 14:35] — Full acceptance test run for MemoryFS v2 (41 tests)

**Task:** Run the complete acceptance test plan at tests/acceptance/memoryfs-v2/test-plan.md
**What I did:** Ran all 41 tests: 27 structural (parallel subagents), 9 behavioral, 8 integration. Set up isolated AX_HOME at /tmp, started server, ran API-level tests programmatically and chat-level tests via `ax send`.
**Files touched:**
- `tests/acceptance/memoryfs-v2/results.md` (new) — full results
- `tests/acceptance/memoryfs-v2/fixes.md` (new) — 5 issues prioritized
- `src/providers/channel/slack.ts` (modified) — fixed Slack debug log spam (FIX-3)
**Outcome:** 27 PASS, 2 FAIL, 2 PARTIAL FAIL, 4 SKIP (no OPENAI_API_KEY). Key findings: (1) LLM summary generator wraps output in markdown code fences corrupting memU format. (2) Content-hash dedup fails against LLM-extracted items because the LLM rephrases facts differently each time. (3) Slack App logLevel was DEBUG causing heartbeat spam in ax.log — fixed to INFO.
**Notes:** Structural tests are a powerful verification layer — all 27 passed, confirming code structure matches the plan. Behavioral failures are all at the LLM integration boundary: non-deterministic LLM output defeats deterministic dedup, and the LLM doesn't follow output format constraints (code fences). Embedding tests (BT-8/9, IT-7/8) need OPENAI_API_KEY to run.

## [2026-03-03 13:15] — Run BT-5 and BT-6 behavioral acceptance tests for MemoryFS v2

**Task:** Run behavioral acceptance tests BT-5 (direct write/read/delete API round-trip) and BT-6 (taint tag preservation) against a live AX server
**What I did:** (1) BT-5: Sent "Remember this exact fact for testing: My favorite database is PostgreSQL" via CLI, verified item appeared in SQLite store with correct content/category/type, then sent "What do you know about my database preferences?" and confirmed agent recalled PostgreSQL. Reinforcement count incremented from 1 to 2 on the recall query. (2) BT-6: Verified structurally that write() serializes taint via JSON.stringify (line 161) and all four read paths (query embedding path line 215, query keyword path line 250, read line 263, list line 280) deserialize via JSON.parse. Chat interface doesn't set taint directly so behavioral testing not feasible.
**Files touched:** No code files modified — read-only acceptance testing
**Outcome:** BT-5 PASS, BT-6 PASS (structural verification)
**Notes:** The memorize/extraction pipeline categorized the PostgreSQL fact as memory_type=profile, category=preferences rather than memory_type=knowledge, category=knowledge. This suggests the LLM extractor is classifying memories into semantic categories rather than using the default knowledge bucket. Reinforcement count going from 1 to 2 on the read query confirms the dedup/reinforce path works correctly in live operation.

## [2026-03-03 11:30] — Add acceptance test skill and tests/acceptance/ directory

**Task:** Create a Claude Code skill that designs, runs, and analyzes acceptance tests for AX features against their original plan documents
**What I did:** Created `.claude/skills/acceptance-test/SKILL.md` — a comprehensive 5-phase skill that walks through feature selection, test design (structural/behavioral/integration), execution against a live server, failure analysis with root cause classification, and fix list generation. Also created `tests/acceptance/README.md` for the test artifact directory.
**Files touched:**
- `.claude/skills/acceptance-test/SKILL.md` (new) — the skill itself
- `tests/acceptance/README.md` (new) — directory README explaining structure
- `.claude/journal/testing/acceptance.md` (new) — this journal entry
- `.claude/journal/testing/index.md` (modified) — added entry reference
**Outcome:** Success. Skill registers automatically and appears in the skills list. Covers all 52 plan files with a feature reference table, provides test templates for 3 categories, includes auto-start server logic, and produces structured output (test-plan.md, results.md, fixes.md).
**Notes:** Key design decisions: (1) Tests are markdown not code because LLM responses are non-deterministic — the agent evaluates with judgment. (2) Two-layer verification: structural ground truth (files, DB, audit) plus behavioral intent checks. (3) Auto-start server with health poll. (4) Test plans saved as artifacts so they can be reviewed before execution and re-run later.

## [2026-03-05 11:55] — Kind cluster acceptance tests KT-1 through KT-4

**Task:** Run Kind cluster acceptance tests KT-1 (pods running), KT-2 (NATS streams), KT-3 (PostgreSQL connectivity), KT-4 (health endpoint)
**What I did:** Executed all four tests against the ax-test namespace on the Kind cluster. KT-1: All 6 running pods confirmed (plus 1 Completed init job). KT-2: Verified 5 NATS JetStream streams (EVENTS, IPC, RESULTS, SESSIONS, TASKS). KT-3: Fixed label selector (pods use `app.kubernetes.io/name` not `app.kubernetes.io/component`) and confirmed both host and agent-runtime pods can query PostgreSQL (`SELECT 1` returns `{"ok":1}`). KT-4: Container lacks wget/curl so used Node.js http module instead; got HTTP 200 `{"status":"ok"}`.
**Files touched:** No code files modified — read-only acceptance testing
**Outcome:** All 4 tests PASS. Two adjustments needed: (1) label selectors use `app.kubernetes.io/name=ax-host` and `app.kubernetes.io/name=ax-agent-runtime` instead of `app.kubernetes.io/component=host|agent-runtime`, (2) health check requires Node.js since the container image has no wget/curl.
**Notes:** The test commands in the plan need updating to use correct label selectors and a Node.js-based health check instead of wget.

## [2026-03-05 12:00] — Kind cluster acceptance tests KT-5 through KT-8

**Task:** Run Kind cluster acceptance tests KT-5 (warm sandbox pods), KT-6 (NATS connectivity), KT-7 (ConfigMap mount), KT-8 (sandbox NATS subscription)
**What I did:** Ran all four tests. Original test scripts used `app.kubernetes.io/component` label selectors which don't match this cluster's labels (`app.kubernetes.io/name` is used instead). Re-ran KT-6 and KT-7 with corrected selectors. KT-5 and KT-8 failed because the pool controller cannot create sandbox pods — the sandbox pods require RuntimeClass "gvisor" which is not installed on the Kind cluster. The pool controller logs show continuous `scaling_up` attempts followed by HTTP 403 `pod rejected: RuntimeClass "gvisor" not found` errors every ~3 seconds.
**Files touched:** No code files modified — read-only acceptance testing
**Outcome:** KT-5: FAIL (no warm sandbox pods — gVisor RuntimeClass missing). KT-6: PASS (all 3 components connect to NATS). KT-7: PASS (ConfigMap mounted at /etc/ax/ax.yaml in all 3 pods). KT-8: FAIL (no sandbox pods exist to check — blocked by gVisor missing).
**Notes:** The gVisor RuntimeClass is a hard requirement for sandbox pod creation. Kind clusters don't ship with gVisor by default. To fix KT-5/KT-8, either: (1) install gVisor on the Kind node, or (2) make the RuntimeClass configurable/optional in the pool controller for dev/test environments. The pool controller is correctly detecting the deficit (current=0, target=1) and attempting to scale up — the logic works, it's just blocked by a missing cluster prerequisite.
