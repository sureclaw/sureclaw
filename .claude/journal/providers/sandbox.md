# Providers: Sandbox

Sandbox providers, canonical paths, workspace tiers.

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
