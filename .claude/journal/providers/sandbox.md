# Providers: Sandbox

Sandbox providers, canonical paths, workspace tiers.

## [2026-03-08 22:35] — Add compare mode for canary validation

**Task:** Implement dual-execution comparison mode for WASM canary validation
**What I did:** Added compare mode logic to dispatch function in sandbox-tools.ts — when `compareMode=true` and route is Tier 1, runs both wasm and default executors via `Promise.allSettled`, serves Tier 2 result, logs mismatches. Extended audit result type with `fallback`, `compare_match`, `compare_mismatch`, `compare_error`. Added 4 tests covering match, mismatch, Tier 2 bypass, and error handling.
**Files touched:** `src/host/ipc-handlers/sandbox-tools.ts`, `src/providers/audit/types.ts`, `src/providers/audit/database.ts`, `tests/host/ipc-handlers/sandbox-tools.test.ts`
**Outcome:** Success — all 2492 tests pass, TypeScript compiles clean
**Notes:** WASM executor returns protected-path policy errors as response objects (not throws), so `.env` write produces compare_mismatch not compare_error.

## [2026-03-08 22:00] — Implement unified WASM sandbox architecture (Phase 0)

**Task:** Implement the unified WASM sandbox plan: extract execution seam, add shadow router, bash classifier, WASM executor with hostcall API, and kill switch config
**What I did:**
1. Created `src/host/sandbox-tools/` module with shared types, executor contract, and barrel export
2. Extracted local executor from sandbox-tools.ts into `local-executor.ts` implementing `SandboxToolExecutor`
3. Extracted NATS executor into `nats-executor.ts` implementing `SandboxToolExecutor`
4. Built shadow router (`router.ts`) with deterministic Tier 1/Tier 2 classification, kill switch, and shadow mode
5. Built strict bash classifier (`bash-classifier.ts`) with allowlisted read-only commands (pwd, ls, cat, head, tail, wc, rg, grep, find, git read-only, echo, basename, dirname, stat, tree, du, df)
6. Refactored `sandbox-tools.ts` to use normalize→route→execute→audit dispatch pattern
7. Added `wasm` config type with `enabled` (kill switch) and `shadow_mode` fields
8. Built WASM executor (`wasm-executor.ts`) with ToolInvocationContext, HostcallAPI (ax.fs.read, ax.fs.write, ax.fs.list, ax.log.emit), protected file enforcement, quota enforcement, deadline checking
9. Added 115 new tests (local executor, bash classifier golden tests, router, WASM executor security)
**Files touched:**
  - Created: src/host/sandbox-tools/{types,local-executor,nats-executor,router,bash-classifier,wasm-executor,index}.ts
  - Modified: src/host/ipc-handlers/sandbox-tools.ts, src/types.ts, src/config.ts
  - Created: tests/host/sandbox-tools/{local-executor,bash-classifier,router,wasm-executor}.test.ts
  - Modified: tests/host/ipc-handlers/sandbox-tools.test.ts (audit args format)
**Outcome:** Success — all 2483 tests pass, zero regressions. Phase 0 complete: execution seam extracted, shadow router active, WASM executor functional with hostcall validation layer.
**Notes:** Phase 1 (actual WASM module compilation) deferred until WASM toolchain selected. The hostcall API layer validates security invariants regardless of whether operations run natively or through WASM modules.

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
