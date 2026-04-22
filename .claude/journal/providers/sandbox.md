# Providers: Sandbox

Sandbox providers, canonical paths, workspace tiers.

## [2026-04-22 07:30] — Plumb `requestId` into `SandboxConfig` + per-pod child logger in k8s

**Task:** Task 1 of the chat-correlation-id plan — give the k8s sandbox provider a way to tag every pod-lifecycle log line with the chat turn's `reqId` so a single grep reconstructs the lifecycle across host + sandbox provider logs.
**What I did:** Added optional `requestId` field to `SandboxConfig` (`src/providers/sandbox/types.ts`). `processCompletion` now passes `requestId` into the spawn-time `sandboxConfig` literal. In `k8s.ts`'s `spawnCold`, built a per-pod child logger pre-bound with `{ reqId: requestId.slice(-8), podName, pid }` and threaded it into `watchPodExit` (new param) and every existing log call site, dropping the now-redundant `podName`/`pid` from each call's details object. Wrote a TDD test that captures pino JSON output via a Writable stream and asserts the bindings appear on every pod-scoped entry; second case verifies `reqId` is omitted when `requestId` is unset.
**Files touched:** `src/providers/sandbox/types.ts`, `src/providers/sandbox/k8s.ts`, `src/host/server-completions.ts`, `tests/providers/sandbox/k8s-correlation.test.ts` (new)
**Outcome:** Success — new test (2 cases) passes; existing k8s test files still green; `npm run build` clean. Pre-existing macOS Unix-socket-path failures in `tests/host/server*.test.ts` are unrelated and reproduce on baseline.
**Notes:** Pino's child bindings override the default top-level `pid` field (the OS process pid) — this is intentional but worth knowing: in JSON output, `pid` becomes the synthetic k8s pid (>= 100_000), not the OS pid. The module-level `logger` (used for `k8s_config_loaded`) stays untouched — only per-pod call sites now use `podLog`. `vi.resetModules()` is required in the test so k8s.ts re-binds the freshly-init'd singleton from `initLogger`.

## [2026-04-21 08:46] — Make sandbox CPU configurable via `config.sandbox.cpus`

**Task:** Expose sandbox CPU as a first-class config field. Previously only `memory_mb` was user-configurable; CPU was hardcoded to `"1"` in the k8s provider (`DEFAULT_CPU_LIMIT`) and to `cpus: 1` at the spawn site in `server-completions.ts`.
**What I did:** Added `cpus` (0.1–16, default 1) to `ConfigSchema` and `Config.sandbox`. Plumbed it through `server-completions.ts` spawn site and `server-init.ts` heavy-tier fallback. Replaced `DEFAULT_CPU_LIMIT` constant with `DEFAULT_CPUS` and made k8s pod spec read `config.cpus`. Docker/Apple providers already read `config.cpus`, so they now receive the user value instead of the hardcoded 1. Heavy-tier override (`cpus: 4`) still takes precedence when `resourceTier: 'heavy'` is requested via delegate.
**Files touched:** `src/config.ts`, `src/types.ts`, `src/providers/sandbox/k8s.ts`, `src/host/server-completions.ts`, `src/host/server-init.ts`, `tests/config.test.ts` (+3 new cases), `tests/providers/sandbox/{k8s,docker,apple}.test.ts`, `tests/providers/llm/router.test.ts`, `tests/providers/channel/slack.test.ts`, `tests/providers/scheduler/plainjob.test.ts`, `tests/host/{server-admin,server-admin-skills,server-admin-oauth-start,server-admin-oauth-providers,scheduler-timeout,registry}.test.ts`, `tests/sandbox-isolation.test.ts`, `tests/integration/{phase1,phase2}.test.ts`, `.claude/skills/ax-config/SKILL.md`
**Outcome:** Success — clean `npm run build`; 54 targeted tests pass.
**Notes:** Made `cpus` required in the TS `Config.sandbox` type (matches the Zod-parsed output) even though the Zod input has `.default(1)`. This forced updates to ~15 inline `Config` fixtures in tests. The heavy-tier `cpus: 4` in `server-init.ts:339` was previously dead (spread into config but spawn site hardcoded 1) — it now takes effect.

## [2026-03-18 08:25] — Fix terminal sandbox pod accumulation in k8s

**Task:** Cold-started k8s sandbox pods were accumulating in Error/Failed state because nothing cleaned them up after exit.
**What I did:** Two-layer fix: (1) Self-cleanup in k8s.ts — after `watchPodExit` resolves, the pod is deleted automatically. (2) Safety net GC in pool controller — added `listTerminalSandboxPods()` to k8s-client.ts that selects ALL `ax-sandbox` pods in Failed/Succeeded phase regardless of tier, and `gcTerminalSandboxPods()` in controller.ts that deletes them during each reconcile cycle.
**Files touched:** `src/providers/sandbox/k8s.ts`, `src/pool-controller/k8s-client.ts`, `src/pool-controller/controller.ts`, `tests/providers/sandbox/k8s.test.ts`, `tests/pool-controller/controller.test.ts`, `tests/pool-controller/k8s-client.test.ts`
**Outcome:** Success — 33 tests pass, clean build.
**Notes:** Root cause: cold-started pods lack `ax.io/tier` label so the per-tier GC in the pool controller never found them. The warm pool pods (with tier labels) were already being GC'd correctly.

## [2026-03-17 14:00] — Implement unified workspace lifecycle (10 tasks)

**Task:** Replace broken three-phase pod orchestration with unified workspace lifecycle
**What I did:** Added workspaceLocation capability to SandboxProvider, created lifecycle.ts module, added provisioning fields to NATS payload, added in-pod provisioning/cleanup to runner and both agent runners, replaced three-phase orchestration with lifecycle dispatch, removed SandboxConfig.network flag, updated skill docs
**Files touched:** src/providers/sandbox/{types,docker,apple,subprocess,k8s}.ts, src/providers/workspace/lifecycle.ts, src/host/server-completions.ts, src/agent/{runner,workspace-cli}.ts, src/agent/runners/{claude-code,pi-session}.ts, src/providers/sandbox/canonical-paths.ts, .claude/skills/ax-provider-sandbox/SKILL.md, 5 new test files
**Outcome:** Success — 209 test files, 2443 tests all pass
**Notes:** 10 commits on feature/nats-centric-workspace-provisioning branch. Host-side providers now use prepareGitWorkspace/finalizeGitWorkspace. K8s uses provisionWorkspaceFromPayload in-pod. Three-phase orchestration fully removed.

## [2026-03-16 16:30] — Fix: NATS 503 actual root cause — double-encoded work payload

**Task:** Debug persistent NATS 503 after three prior fix attempts (ipcToken, Helm, permissions)
**What I did:** Added diagnostic stderr logging to NATSIPCClient.setContext and call() to trace the exact subject used. Deployed and saw `applyPayload ipcToken=MISSING requestId=MISSING sessionId=MISSING` — ALL fields missing, not just ipcToken. Also noticed host sends 6309 bytes but sandbox receives 6567 bytes. Traced to `publishWork` in host-process.ts calling `encode(payload)` where `encode()` does `JSON.stringify(obj)` and `payload` is already a JSON string. Double-serialization wraps the JSON in quotes and escapes everything: `"{\"message\":\"hello\",...}"`. Sandbox receives this, `JSON.parse` produces a plain string (not an object), `parseStdinPayload` falls through to defaults with all fields undefined.
**Fix:** Replace `encode(payload)` with `new TextEncoder().encode(payload)` — raw UTF-8 encoding without extra JSON.stringify.
**Files touched:** src/host/host-process.ts (fix), src/agent/nats-ipc-client.ts (diagnostics), src/agent/runner.ts (diagnostics), tests/agent/nats-warm-pod-flow.test.ts (reproducing test)
**Outcome:** Success — 212 test files, 2477 tests pass. Reproducing test confirms double-encoding destroys the payload and direct TextEncoder preserves it.
**Notes:** The byte count mismatch (6309 vs 6567 = +258 bytes) was the clue — extra bytes from JSON string escaping/quoting. The diagnostic `ipcToken=MISSING requestId=MISSING` proved ALL fields were lost, not just ipcToken. Previous fixes (ipcToken in payload, Helm NATS_SANDBOX_PASS, NATS permissions) were all real bugs but masked by this upstream double-encoding.

## [2026-03-16 15:45] — Fix: complete NATS 503 triple root cause (Helm + permissions + token)

**Task:** Fix remaining NATS 503 after ipcToken code fix — pods still failing in k8s
**What I did:** Discovered two additional root causes beyond the ipcToken fix:
1. **Helm: missing NATS_SANDBOX_PASS** — Pool controller and host deployments didn't inject `NATS_SANDBOX_PASS` from the nats-auth secret. Sandbox pods were created without NATS credentials → connected anonymously → restricted permissions.
2. **NATS permissions: missing agent.work.> subscribe** — Sandbox user could only subscribe to `_INBOX.>`. Warm pods need `agent.work.>` to receive work payloads. Added it to subscribe allow list.
3. **Tests first** — Added 8 new tests before fixing: NATSIPCClient setContext with token reproducing the 503 subject mismatch, parseStdinPayload ipcToken extraction, pool controller k8s-client NATS credential injection (5 tests).
**Files touched:** charts/ax/templates/pool-controller/deployment.yaml, charts/ax/templates/host/deployment.yaml, charts/ax/values.yaml, tests/agent/nats-ipc-client.test.ts, tests/agent/runner.test.ts, tests/pool-controller/k8s-client.test.ts
**Outcome:** Success — build clean, 210 test files, 2471 tests pass
**Notes:** Three independent bugs conspired: (a) wrong NATS subject (missing token), (b) no NATS credentials (Helm chart gap), (c) no subscribe permission for work delivery subject. All three needed fixing for production.

## [2026-03-16 15:30] — Fix: warm pool pods missing IPC token (NATS 503 No Responders)

**Task:** Fix agent_response and LLM calls failing with NATS 503 for warm pool pods
**What I did:** The IPC token (`AX_IPC_TOKEN`) was only passed as a pod env var via `extraSandboxEnv`, but warm pool pods are pre-created before the request — they don't have this env var. The NATSIPCClient fell back to `ipc.request.{sessionId}` instead of `ipc.request.{requestId}.{token}`, causing "No Responders" since the host handler subscribes to the token-scoped subject. Fix: (1) Added `ipcToken` to the stdinPayload in server-completions.ts. (2) Added `token` to `IIPCClient.setContext()` interface and both implementations. (3) `applyPayload()` now passes `payload.ipcToken` via `setContext()` to the NATSIPCClient, which rebuilds the subject.
**Files touched:** src/agent/runner.ts, src/agent/ipc-client.ts, src/agent/nats-ipc-client.ts, src/host/server-completions.ts
**Outcome:** Success — build clean, 209 test files, 2463 tests pass
**Notes:** Cold-start pods still get the token via env var (both paths work). For warm pods, the work payload is the only delivery mechanism since the pod exists before the request.

## [2026-03-16 15:00] — Pure NATS communication for k8s sandbox (eliminate stdin/stdout/exec)

**Task:** Replace legacy stdin/stdout/exec-based k8s sandbox communication with pure NATS. Eliminate k8s Exec API, Attach API, and stdout-based response capture for k8s mode.
**What I did:** Major refactor across 11 files:
1. Added `agent_response` IPC action in ipc-schemas.ts for agents to send responses via NATS
2. Redirected logger to stderr (fd 2) when AX_IPC_TRANSPORT=nats to prevent pino log pollution
3. Runner: added `waitForNATSWork()` — subscribes to `agent.work.{POD_NAME}`, extracted `applyPayload()` helper
4. Agent runners (pi-session, claude-code): buffer text instead of stdout, send via `agent_response` IPC in NATS mode
5. K8s provider: removed `buildExecCommand()`, exec/attach APIs. spawnCold/spawnWarm return podName + dummy streams
6. Host: processCompletionWithNATS intercepts agent_response, publishes work to `agent.work.{podName}` via NATS
7. Pool controller: renamed WARM_POD_STANDBY_COMMAND → WARM_POD_RUNNER_COMMAND (runner IS the standby)
8. Added `podName` to SandboxProcess interface in types.ts
9. Fixed 3 test files (tool-catalog-sync, main.test, k8s-warm-pool)
**Files touched:** src/ipc-schemas.ts, src/logger.ts, src/agent/runner.ts, src/agent/agent-setup.ts, src/agent/runners/pi-session.ts, src/agent/runners/claude-code.ts, src/providers/sandbox/k8s.ts, src/providers/sandbox/types.ts, src/host/host-process.ts, src/host/server-completions.ts, src/pool-controller/k8s-client.ts, src/pool-controller/main.ts, tests/agent/tool-catalog-sync.test.ts, tests/pool-controller/main.test.ts, tests/providers/sandbox/k8s-warm-pool.test.ts
**Outcome:** Success — 209 test files, 2463 tests all passing. Build clean.
**Notes:** Subprocess/seatbelt modes completely unchanged. The key insight: warm pool pods run runner.js directly (not sleep), runner subscribes to NATS for work → IS the standby. This eliminates the k8s Exec API entirely.

## [2026-03-16 07:37] — Set AX_IPC_TRANSPORT=nats in k8s pod env

**Task:** Update k8s sandbox provider to use NATS IPC instead of Unix sockets (pods can't access host filesystem)
**What I did:** In buildPodSpec() env array, added AX_IPC_TRANSPORT=nats env var and filtered out AX_IPC_SOCKET from canonicalEnv() output. Added test verifying transport env is set and socket env is excluded.
**Files touched:** src/providers/sandbox/k8s.ts, tests/providers/sandbox/k8s.test.ts
**Outcome:** Success — 14 tests passing in k8s.test.ts
**Notes:** canonicalEnv() includes AX_IPC_SOCKET by default; k8s pods need NATS transport since they can't share the host Unix socket.

## [2026-03-14 13:06] — Per-tier workspace permission hardening

**Task:** Make /workspace root read-only, split workspaceMountsWritable into per-tier flags (agentWorkspaceWritable, userWorkspaceWritable), implement k8s scope provisioning via GCS, add transport abstraction.
**What I did:** Executed 10-task plan: replaced workspaceMountsWritable with per-tier flags in types/host/all providers, made workspace root read-only in nsjail+bwrap, extended claim protocol with scope info, added provisionScope/diffScope to sandbox worker, updated k8s pod spec with workspace volumes, added GCS transport abstraction (LocalTransport/RemoteTransport), updated docs.
**Files touched:** src/providers/sandbox/types.ts, src/providers/sandbox/{docker,nsjail,bwrap,seatbelt,apple,k8s}.ts, src/providers/sandbox/canonical-paths.ts, src/host/server-completions.ts, src/host/nats-sandbox-dispatch.ts, src/sandbox-worker/{types,workspace,worker}.ts, src/providers/workspace/gcs.ts, policies/agent.sb, .claude/skills/ax/provider-sandbox/SKILL.md, tests/sandbox-isolation.test.ts, tests/sandbox-worker/{types,workspace}.test.ts, tests/providers/workspace/gcs-transport.test.ts
**Outcome:** Success — 208 test files, 2434 tests all passing.
**Notes:** Pure extraction for GCS transport — LocalTransport is a behavior-preserving refactor of createGcsBackend.

## [2026-03-14 09:30] — Fix Apple Container IPC bridge: timing + tmpfs

**Task:** Fix IPC bridge for Apple Container sandbox — agent inside VM couldn't communicate with host via --publish-socket
**What I did:** Fixed two independent bugs preventing IPC data flow through --publish-socket:
1. **Timing**: Host was connecting to the host-side publish-socket BEFORE the agent's listener was ready inside the VM. Added `[signal] ipc_ready` — agent emits via stderr when `net.Server.listen()` completes, host waits for this signal before connecting the bridge.
2. **tmpfs hiding socket**: `--tmpfs /tmp` created a tmpfs overlay that hid the bridge socket from the publish-socket runtime's in-VM forwarding agent. Removed `--read-only` and `--tmpfs /tmp` (VM boundary provides security isolation).
**Files touched:**
  - Modified: src/agent/ipc-client.ts (signal on listen ready), src/host/server-completions.ts (wait for signal before bridge connect), src/providers/sandbox/apple.ts (remove --read-only/--tmpfs)
**Outcome:** Success — IPC bridge now works end-to-end through virtio-vsock
**Notes:** Debugging required 7 iterations. Key diagnostic: `[diag] ipc_listen_accepted` never appearing confirmed the runtime wasn't forwarding the host connection. Two root causes masked each other — fixing timing alone didn't help because tmpfs was also blocking, and fixing tmpfs alone didn't help because of timing.

## [2026-03-14 12:00] — Add Apple Container sandbox provider

**Task:** Add a new sandbox provider using Apple's `container` CLI for lightweight VM-based isolation on macOS (Apple Silicon).
**What I did:** Created `apple-container.ts` mirroring the Docker provider pattern. Uses `container run` with `--rm`, `-i`, `--read-only`, `--tmpfs /tmp`, `--memory`, `--cpus`, and `--publish-socket` for IPC socket forwarding. No `--network` flag needed (Apple Container has no network by default). Registered in provider-map.ts, added to onboarding PROVIDER_CHOICES, created test file, updated sandbox skill docs.
**Files touched:**
  - Created: src/providers/sandbox/apple-container.ts, tests/providers/sandbox/apple-container.test.ts
  - Modified: src/host/provider-map.ts, src/onboarding/prompts.ts, .claude/skills/ax/provider-sandbox/SKILL.md
**Outcome:** Success — all 4 tests pass, no unique build errors (pre-existing @types/node issues only)
**Notes:** Apple Container uses `--publish-socket` (unique feature) for Unix socket forwarding instead of volume-mounting the socket directory. VM boundary provides stronger isolation than Docker's shared-kernel model, so `--cap-drop`, `--pids-limit`, `--security-opt` are unnecessary.

## [2026-03-13 09:40] — Remove identity mount from sandbox (Phase 4)

**Task:** Remove the /workspace/identity mount from the sandbox. Identity files now come via stdin payload from DocumentStore.
**What I did:** (1) Removed `CANONICAL.identity` from canonical-paths.ts, `AX_AGENT_DIR` from canonicalEnv/symlinkEnv, identity symlink from createCanonicalSymlinks. (2) Removed `agentDir` from SandboxConfig, CompletionDeps, AgentConfig, parseArgs(). (3) Removed identity mount from all 4 sandbox providers (docker, bwrap, nsjail, seatbelt). (4) Updated seatbelt policy (policies/agent.sb) to remove AGENT_DIR parameter and read rule. (5) Updated agent-setup.ts to remove agentDir fallback. (6) Deprecated path helpers (agentIdentityDir, agentIdentityFilesDir, agentSkillsDir, userSkillsDir). (7) Updated sandbox-isolation tests and canonical-paths tests. (8) Fixed pi-session test to use preloaded identity instead of agentDir.
**Files touched:**
  - Modified: src/providers/sandbox/canonical-paths.ts, types.ts, seatbelt.ts, docker.ts, bwrap.ts, nsjail.ts
  - Modified: src/host/server-completions.ts, server.ts, agent-runtime-process.ts
  - Modified: src/agent/runner.ts, agent-setup.ts
  - Modified: src/paths.ts, policies/agent.sb
  - Modified: tests/providers/sandbox/canonical-paths.test.ts, tests/sandbox-isolation.test.ts, tests/agent/runners/pi-session.test.ts
**Outcome:** Success — build passes, all 2377 tests pass
**Notes:** The host-side `agentDir` in IPCHandlerOptions/GovernanceHandlerOptions remains unchanged — it's the host-side path for governance proposals, not the sandbox mount.

## [2026-03-05 13:00] — Wire NATS sandbox dispatch into agent-runtime IPC pipeline

**Task:** Connect NATSSandboxDispatcher to the IPC tool handler pipeline so sandbox tools dispatch via NATS to remote sandbox pods in k8s mode
**What I did:** (1) Added `natsDispatcher` and `requestIdMap` to `IPCHandlerOptions`, passed through to `createSandboxToolHandlers()`. (2) In `agent-runtime-process.ts`: instantiate dispatcher when `config.providers.sandbox === 'k8s-pod'`, create requestIdMap, populate it per-session, release pods at end of turn, clean up on shutdown. (3) Fixed critical JetStream ack interference bug: `nc.request()` on subjects covered by JetStream streams returns the stream publish ack instead of the worker's reply. Changed claim to use manual `nc.publish()` + `nc.subscribe()` with inbox filtering. (4) Added structured logging to sandbox-tools.ts. (5) Updated unit test mocks for new claim pattern.
**Files touched:**
  - Modified: src/host/agent-runtime-process.ts, src/host/ipc-server.ts, src/host/nats-sandbox-dispatch.ts, src/host/ipc-handlers/sandbox-tools.ts, tests/host/nats-sandbox-dispatch.test.ts
  - Updated: tests/acceptance/k8s-agent-compute/results.md, tests/acceptance/k8s-agent-compute/fixes.md
**Outcome:** Success. IT-3 and IT-4 now PASS. All 42/42 acceptance tests pass. 2411 unit tests pass.
**Notes:** JetStream ack interference was the key discovery — when a JetStream stream covers a subject, `nc.request()` gets the 27-byte stream ack before the actual worker reply. Manual publish/subscribe with inbox filtering is the solution.

## [2026-03-04 21:15] — NATS sandbox dispatch + k8s-pod SandboxProvider

**Task:** Phase 2 Tasks 6-7: NATS-based IPC for sandbox tool dispatch and k8s-pod SandboxProvider.
**What I did:** (1) Created NATS dispatch protocol types (src/sandbox-worker/types.ts). (2) Created sandbox worker process (src/sandbox-worker/worker.ts) — NATS consumer that runs in pods, subscribes to task queue, executes tools locally, returns results via request/reply. (3) Created NATS dispatch client (src/host/nats-sandbox-dispatch.ts) with per-turn pod affinity (requestId → pod subject). (4) Modified sandbox-tools.ts to support NATS dispatch mode alongside local execution. (5) Created k8s-pod SandboxProvider using @kubernetes/client-node — creates pods with gVisor runtime, security hardening, NATS env.
**Files touched:**
  - Created: src/sandbox-worker/types.ts, src/sandbox-worker/worker.ts, src/host/nats-sandbox-dispatch.ts, src/providers/sandbox/k8s-pod.ts, tests/sandbox-worker/worker.test.ts, tests/host/nats-sandbox-dispatch.test.ts, tests/providers/sandbox/k8s-pod.test.ts
  - Modified: src/host/ipc-handlers/sandbox-tools.ts, src/host/provider-map.ts, tests/host/ipc-handlers/sandbox-tools.test.ts, tests/host/provider-map.test.ts, tests/integration/phase2.test.ts
**Outcome:** Success. 2368 tests pass (36 new), 3 pre-existing failures only.
**Notes:** Provider map regex needed update from [a-z-] to [a-z0-9-] to accommodate k8s-pod name. NATS dispatch uses request/reply pattern for synchronous tool calls + queue groups for load balancing.

## [2026-03-02 11:42] — Nest CANONICAL paths under /workspace, make mount root the CWD

**Task:** Fix bug where agent can't access ./agent and ./user from CWD because CWD was /scratch (a sibling, not a parent). Also fix userId mismatch in IPC context.
**What I did:** (1) Added `root: '/workspace'` to CANONICAL and nested all paths under /workspace. (2) Changed CWD/HOME in all 5 sandbox providers (docker, bwrap, nsjail, seatbelt, subprocess) from CANONICAL.scratch to CANONICAL.root/mountRoot. (3) Updated canonicalEnv to set AX_WORKSPACE to CANONICAL.root, symlinkEnv to set AX_WORKSPACE to mountRoot. (4) Added userId to IPCClientOptions and enrichment in ipc-client.ts. (5) Added _userId extraction in ipc-server.ts handleIPC. (6) Both runners (pi-session, claude-code) now pass userId to IPCClient. (7) Updated runtime prompt to reference ./scratch, ./agent, ./user. (8) Updated all tests.
**Files touched:** `src/agent/ipc-client.ts`, `src/host/ipc-server.ts`, `src/agent/runners/pi-session.ts`, `src/agent/runners/claude-code.ts`, `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/nsjail.ts`, `src/providers/sandbox/seatbelt.ts`, `src/providers/sandbox/subprocess.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/` (6 files)
**Outcome:** Success — build clean, all 2007 tests pass
**Notes:** The key insight is that mount root (not scratch) must be the CWD so that ./scratch, ./agent, ./user are all accessible as relative paths.

## [2026-03-01 15:57] — Rename canonical paths: /agent→/identity, /shared→/agent

**Task:** Fix confusing mismatch between IPC tier name "agent" and mount path "/shared" by aligning the path to the tier name
**What I did:** (1) Renamed identity dir from `CANONICAL.agent` (`/agent`) to `CANONICAL.identity` (`/identity`). (2) Renamed workspace from `CANONICAL.shared` (`/shared`) to `CANONICAL.agent` (`/agent`). Updated canonical-paths.ts (constants, canonicalEnv, createCanonicalSymlinks, symlinkEnv), all 3 sandbox providers (docker, bwrap, nsjail), runtime prompt, and all related tests.
**Files touched:** `src/providers/sandbox/canonical-paths.ts`, `src/providers/sandbox/docker.ts`, `src/providers/sandbox/bwrap.ts`, `src/providers/sandbox/nsjail.ts`, `src/agent/prompt/modules/runtime.ts`, `tests/providers/sandbox/canonical-paths.test.ts`, `tests/agent/prompt/enterprise-runtime.test.ts`
**Outcome:** Success — build clean, all 2005 tests pass, zero stale `/shared` or `CANONICAL.shared` references remain
**Notes:** The existing `CANONICAL.agent` was occupied by the identity directory, so we needed a two-step swap: identity `/agent`→`/identity`, then workspace `/shared`→`/agent`.
