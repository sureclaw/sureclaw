## [2026-03-23 19:40] — Optimize workspace provisioning: parallel GCS downloads

**Task:** Fix slow workspace provisioning (~50s for 473 files / 7.4MB user workspace) in k8s mode
**What I did:**
1. Identified root cause: `downloadScope()` in gcs.ts downloads files sequentially — 473 GCS API calls at ~100ms each = ~47s
2. Added parallel downloads (batches of 20 concurrent) — reduces to ~3s
3. Initially added in-memory cache + ETag support, but removed: doesn't work with multiple host replicas (each has independent cache, no cross-replica invalidation)
**Files touched:**
- `src/providers/workspace/gcs.ts` — Parallel downloads in `downloadScope()`
**Outcome:** Success. Build clean, all 2557 tests pass. Expected ~10x speedup (parallel GCS downloads).
**Notes:** In-memory caching was removed because it's unsafe with multiple host replicas — `setRemoteChanges()` only invalidates the local replica's cache. Future optimization: use GCS object generation metadata for ETag-based caching that works across replicas.

## [2026-03-23 19:25] — Fix empty agent_response hang + skill reinstall in k8s

**Task:** Debug two issues in kind-ax cluster: (1) agent reinstalls already-installed skills, (2) flaky/hanging responses
**What I did:**
1. Diagnosed that `if (response)` at server-completions.ts:989 uses JS truthiness — empty string `''` is falsy, so empty agent responses (tool-call-only sessions) fall through to waiting for cold-start pod exit (~120s hang)
2. Diagnosed that the `skill` tool with `type: "install"` is always in the tool catalog regardless of `skillInstallEnabled`, causing the LLM to install skills even when the system prompt says not to
3. Fix #1: Added `agentResponseReceived` boolean flag set when the promise resolves, used instead of truthiness check
4. Fix #2: Added `skillInstallEnabled` to `ToolFilterContext`, filter out `skill` tool when false
5. Updated all tests (tool-catalog, mcp-server, ipc-tools, skills module) — 2557 tests pass
**Files touched:**
- `src/host/server-completions.ts` — `agentResponseReceived` flag instead of `if (response)` truthiness
- `src/agent/tool-catalog.ts` — Added `skillInstallEnabled` to ToolFilterContext, filter skill category
- `src/agent/agent-setup.ts` — Wire `skillInstallEnabled` into toolFilter return
- `tests/agent/tool-catalog.test.ts` — Updated filter tests for skillInstallEnabled
- `tests/agent/mcp-server.test.ts` — Updated filter tests
- `tests/agent/ipc-tools.test.ts` — Updated filter tests
- `tests/agent/prompt/modules/skills.test.ts` — Added regression test case
**Outcome:** Success. Both bugs fixed, all 2557 tests pass. Kind cluster had filesystem corruption preventing image reload — needs Docker Desktop restart to verify in k8s.
**Notes:** The two issues are connected: agent installs skill (tool call, no text) → sends empty response → empty string is falsy → host hangs 120s waiting for cold-start pod → timeout/error. Also found that user workspace provisioning takes ~50s for 473 files (7.4MB) on every heartbeat — potential optimization target.

## [2026-03-22 16:30] — Fix agent_response timeout race in k8s NATS mode

**Task:** Debug and fix the skill install + Linear API teams query sequence on the kind-ax cluster
**What I did:**
1. Diagnosed that `agentResponsePromise` timer started BEFORE `processCompletion` ran, causing timeout before sandbox spawn
2. Root cause: Guardian scanner LLM classification call took ~5 minutes, eating into the 3-minute agent_response timeout
3. Fix: Deferred timer start to AFTER work is published via NATS, so pre-processing (scanner, workspace mount, CA gen) doesn't eat the timeout budget
4. Added `startAgentResponseTimer` callback to `CompletionDeps`, called in `processCompletion` after `publishWork`
5. Verified MITM credential replacement works end-to-end (skill install → credential provide → Linear API call)
**Files touched:**
- `src/host/server-k8s.ts` — Deferred timer to callback, removed upfront setTimeout
- `src/host/server-completions.ts` — Added `startAgentResponseTimer` to CompletionDeps, call after publishWork
- `src/host/credential-placeholders.ts` — Temporary debug logging (removed)
**Outcome:** Success. Full sequence works: install skill → provide credential → list Linear teams (3 teams returned)
**Notes:** The guardian scanner with `llmAvailable: true` was the main bottleneck — its LLM classification call takes variable time. The previous timer started 180s before sandbox spawn, but processCompletion setup (including the scanner) can take minutes.
