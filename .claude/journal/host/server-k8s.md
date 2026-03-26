## [2026-03-26 05:48] — Fix session pod idle timeout race with watchPodExit

**Task:** Session pod ax-sandbox-8d9dfaf1 idle for 30+ minutes but not killed
**What I did:** Root-caused a race between two independent timers managing the same pod lifecycle: (1) session-pod-manager's idle timer (fires at idle_timeout_sec from last activity), (2) watchPodExit's safety timer (fires at idle_timeout_sec+30s from pod creation). When the pod had any IPC activity, the idle timer was pushed later, but watchPodExit's safety timer was fixed from creation. watchPodExit fired first, resolved proc.exitCode, which triggered removeSessionPod — clearing the idle timer without calling kill. If the k8s pod deletion also failed, the pod lived forever with no timer to ever kill it.
**Fix:** Five changes across three layers of defense:
1. Set watchPodExit timeout to 86400s (24h) for session pods — distant backstop, session-pod-manager owns lifecycle.
2. Added podKill() call in proc.exitCode safety net so orphan pods are killed on watchPodExit resolution.
3. Moved idle timer touch from per-IPC-call to turn end — idle countdown starts when processCompletion finishes, not after last IPC activity.
4. Added `activeDeadlineSeconds` to k8s pod spec — k8s-native safety net that survives host crashes. Uses `(timeoutSec + 300)s`.
5. Added stale Running pod GC to pool controller — catches orphans from host crashes where all in-memory timers were lost. Default 2h max age.
**Files touched:**
  - Modified: src/host/server-completions.ts (timeoutSec + safety net kill)
  - Modified: src/host/server-k8s.ts (remove per-IPC touch, add turn-end touch, add removeSessionPod)
  - Modified: src/providers/sandbox/k8s.ts (activeDeadlineSeconds)
  - Modified: src/pool-controller/controller.ts (gcStaleSandboxPods)
  - Modified: src/pool-controller/k8s-client.ts (listStaleSandboxPods)
  - Modified: tests/host/session-pod-manager.test.ts (2 new tests)
  - Modified: tests/pool-controller/controller.test.ts (mock listStaleSandboxPods)
**Outcome:** Success. All tests pass (14 session-pod-manager, 8 pool-controller), TypeScript compiles clean.
**Notes:** Defense-in-depth: (1) session-pod-manager idle timer (primary, in-memory), (2) watchPodExit 24h backstop (secondary, in-memory), (3) k8s activeDeadlineSeconds (tertiary, survives host crash), (4) pool controller stale GC (quaternary, periodic external check).

## [2026-03-26 05:20] — Make skill tool always available (not gated by install intent)

**Task:** Fix agent not seeing skill tools (skill.delete, skill.update) when user message doesn't match install intent patterns
**What I did:** Changed `filterTools()` in tool-catalog.ts to always include the `skill` category. Previously gated by `ctx.skillInstallEnabled !== false`, but `buildSystemPrompt()` explicitly set `skillInstallEnabled = false` by default, only enabling on install-intent patterns ("install", "add", "find" etc). "delete" and "remove" were not in the pattern list. The install instructions in the prompt module remain gated by intent — only the tool availability changed.
**Files touched:**
  - Modified: src/agent/tool-catalog.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts
**Outcome:** Success. Agent now sees `skill` tool on all turns. 2620 tests pass. Verified on kind-ax cluster — "delete the linear skill" triggers skill tool call.
**Notes:** The `skillInstallEnabled` flag still exists in `ToolFilterContext` and `PromptContext` — it controls the install INSTRUCTIONS in the SkillsModule prompt, not tool availability.

## [2026-03-25 21:30] — Fix session pod premature death + credential scope fallback

**Task:** Debug and fix two bugs: (1) session pods dying after 150s due to watchPodExit safety timeout, causing "Thinking..." hang on next turn; (2) credentials stored with `global` scope not found by resolveCredential
**What I did:** Three changes:
1. `server-completions.ts`: Use `idle_timeout_sec` (1800s) instead of `timeout_sec` (120s) for session pod sandbox config, so `watchPodExit` safety timeout doesn't kill them prematurely.
2. `server-completions.ts` + `server-k8s.ts`: Added `removeSessionPod` dep + `proc.exitCode.then()` listener to clean up session-pod-manager mapping when pod exits unexpectedly.
3. `credential-scopes.ts`: Added global (unscoped) fallback to `resolveCredential()` — catches credentials stored when session context was unavailable (host restart between completion and credential provide).
**Files touched:**
  - Modified: src/host/server-completions.ts, src/host/server-k8s.ts, src/host/credential-scopes.ts, tests/host/credential-scopes.test.ts
**Outcome:** Success. Credential found on first try (`available: true`), pod persists beyond old 150s timeout. 2618 tests pass.
**Notes:** Root cause: `watchPodExit` in k8s.ts has a `.then()` on exitCode that deletes the pod. For session pods, this fired at (timeout_sec+30)s, but session pods should live for idle_timeout_sec. The exitCode cleanup listener is a safety net for any unexpected pod death (OOM, crash, etc.).

## [2026-03-25 18:10] — Two-tier idle timeout for session pods (clean vs dirty)

**Task:** Add shorter idle timeout for sandbox pods with no filesystem changes
**What I did:** Added `dirty` flag to `SessionPod`, `cleanIdleTimeoutMs` option, and `markDirty()` method to session-pod-manager. Clean sessions (no FS writes) use shorter timeout (default 5min), dirty sessions use full timeout (default 30min). Wired into `server-k8s.ts` — IPC interceptor marks session dirty on `sandbox_bash`, `sandbox_write_file`, `sandbox_edit_file`, `workspace_write`, `workspace_release` actions. Added `idle_timeout_sec` and `clean_idle_timeout_sec` to sandbox config schema and Helm values.
**Files touched:**
  - Modified: src/host/session-pod-manager.ts, src/host/server-k8s.ts, src/config.ts, src/types.ts, charts/ax/values.yaml, tests/host/session-pod-manager.test.ts
**Outcome:** Success. 12 tests pass (up from 6). TypeScript compiles (only pre-existing error in skills.ts).
**Notes:** `DIRTY_ACTIONS` set is defined inside the per-turn closure in server-k8s.ts. `markDirty()` is idempotent and resets the timer on first dirty mark so the longer timeout takes effect immediately.

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
