# Sandbox Dispatch

Local and NATS-based sandbox dispatching, lazy sandbox spawning, NATS IPC handler.

## [2026-03-18 17:30] — Fix agent hang on network bash commands (npm install deadlock)

**Task:** Debug and fix deadlock where asking the agent to run `npm install -g @googleworkspace/cli` causes it to hang indefinitely.
**What I did:** Root-caused a deadlock: in container mode, `execFileSync` blocks the event loop while npm routes through the web proxy, which blocks for 120s waiting for domain approval the agent can't send. Five-part fix: (1) Auto-approve well-known registry domains (npm, pip, yarn, etc.) before bash execution in `local-sandbox.ts`. (2) Replace `execFileSync` with async `spawn` in `local-sandbox.ts`. (3) Replace `execSync` with async `spawn` in `sandbox-tools.ts`, increase timeout 30s→120s. (4) Increase bash tool IPC timeout 60s→180s in `tool-catalog.ts`. (5) Add `MAX_TOOL_CALLS=50` limit in pi-session runner to prevent infinite retry loops.
**Files touched:** `src/agent/local-sandbox.ts`, `src/host/ipc-handlers/sandbox-tools.ts`, `src/agent/tool-catalog.ts`, `src/agent/runners/pi-session.ts`, `tests/agent/local-sandbox.test.ts`, `tests/host/ipc-handlers/sandbox-tools.test.ts`
**Outcome:** Success — all 2398 tests pass (203 files), tsc builds clean.
**Notes:** The deadlock was a circular wait: agent → npm → proxy → agent. The auto-approve breaks the cycle by pre-approving domains before the command runs. Async spawn is a defense-in-depth measure so the event loop stays responsive. The maxToolCalls limit prevents the pi-session runner from looping infinitely (claude-code already had maxTurns: 20).

## [2026-03-16 18:00] — Update ax-host skill to reflect NATS IPC handler and deleted files

**Task:** Update `.claude/skills/ax-host/SKILL.md` to reflect deleted files (nats-sandbox-dispatch.ts, agent-runtime-process.ts, local-sandbox-dispatch.ts), new nats-ipc-handler.ts, three-phase container orchestration, warm pool, IPC server fixes, sandbox-tools audit gate, provider-map changes, and streaming fixes.
**What I did:** Removed references to deleted files, added entries for nats-ipc-handler.ts, host-process.ts, sandbox-tools.ts. Rewrote NATS Subsystem section with three-component model. Added Warm Pool subsection. Updated Provider Map with sandbox/workspace/skills categories. Added 9 new gotchas covering concurrent IPC, proxy.sock race, agent_response timeout, three-phase orchestration, per-turn NATS handler, deleted files, and error redaction.
**Files touched:** `.claude/skills/ax-host/SKILL.md`
**Outcome:** Success — skill file now accurately reflects current codebase state
**Notes:** Verified against actual filesystem: nats-sandbox-dispatch.ts, agent-runtime-process.ts, local-sandbox-dispatch.ts are all confirmed deleted. nats-ipc-handler.ts, host-process.ts, sandbox-tools.ts are all confirmed present.

## [2026-03-15 04:20] — Implement agent-in-container design for Docker/Apple sandboxes

**Task:** Run agent processes inside Docker/Apple containers instead of overriding to subprocess. Tool calls (sandbox_bash) spawn ephemeral containers via the host.
**What I did:** (1) Removed subprocess override in server-completions.ts — docker/apple agents now run in-container via the sandbox provider's spawn(). (2) Added `containerSandbox` option to SandboxToolHandlerOptions and IPCHandlerOptions. (3) Added container dispatch path in sandbox_bash that spawns ephemeral containers via execInContainer(). (4) Made ipcSocket optional in Docker and Apple providers (empty string = no socket mount/bridge, for tool containers). (5) Passed containerSandbox from server.ts to createIPCHandler when sandbox is docker/apple. (6) File ops (read/write/edit) continue to run locally with safePath protection.
**Files touched:** src/host/server-completions.ts, src/host/ipc-server.ts, src/host/server.ts, src/host/ipc-handlers/sandbox-tools.ts, src/providers/sandbox/docker.ts, src/providers/sandbox/apple.ts, tests/host/ipc-handlers/sandbox-tools.test.ts
**Outcome:** Success — all 2449 tests pass
**Notes:** NATS dispatch (k8s) still takes priority over container dispatch. The execInContainer helper collects stdout+stderr and returns exit code.

## [2026-03-14 14:30] — Consolidate session scope into scratch (no separate /workspace/session)

**Task:** Remove duplicate session/ directory — scratch/ and session/ served the same purpose
**What I did:** Removed CANONICAL.session, sessionWorkspace from SandboxConfig, session-ws from k8s pod spec, hasSessionWorkspace from prompt context, AX_SESSION_WORKSPACE env var. Instead, workspace provider's 'session' scope backs scratch via GCS: host mounts session scope and uses its path as the scratch workspace; sandbox worker provisions session scope into CANONICAL.scratch. The LLM just sees `./scratch` — GCS persistence is transparent.
**Files touched:** All files from previous session scope commit, reverted the separate-path approach
**Outcome:** Success — all 2444 tests pass
**Notes:** Key design decision: 'session' scope still exists in the workspace provider (it's the backend mechanism for GCS persistence), but it's not a separate user-facing directory. The claim request still includes `scopes.session` for the worker to know about GCS.

## [2026-03-14 13:50] — Fix workspace commit dropping user scope changes

**Task:** User workspace changes not appearing in GCS after end-of-turn commit
**What I did:** Root cause: `shared.ts` orchestrator stored `userId` during `mount()` but didn't remember it for `commit()`. The commit built a `ScopeContext` without `userId`, so `scopeId('user', ctx)` fell back to `sessionId` instead of `userId`. This meant `backend.diff('user', sessionId)` instead of `backend.diff('user', 'alice')` — wrong directory, no changes found, nothing committed. Fix: added `sessionUserIds` map to the orchestrator, populated during mount(), used during commit(), cleaned up during cleanup(). Added 3 tests.
**Files touched:** `src/providers/workspace/shared.ts`, `tests/providers/workspace/shared.test.ts`
**Outcome:** Success — all 2442 tests pass
**Notes:** The `agent/assistant/scratch/` in GCS is a leftover from the previous behavior where workspaceMap pointed at agentWsPath — all writes went to the agent workspace, including scratch files. The user should clear that from the bucket.

## [2026-03-14 13:25] — Fix agent/user workspace visibility in sandbox tools

**Task:** Agent couldn't see user/ and agent/ directories via sandbox tools (bash, read_file, etc.)
**What I did:** Root cause: processCompletion stored the scratch workspace dir in workspaceMap, but agent/ and user/ symlinks were only created inside the sandbox provider's spawn() (local to that scope). Sandbox tool IPC handlers used workspaceMap as CWD, so they had no sibling agent/user dirs. Fix: (1) Create a symlink mountRoot in processCompletion using createCanonicalSymlinks, store it in workspaceMap so sandbox tools see scratch/, agent/, user/ as siblings. (2) Added hasAgentWorkspace/hasUserWorkspace to PromptContext so the runtime prompt tells the LLM about these directories. (3) Cleanup mountRoot in finally block.
**Files touched:** `src/host/server-completions.ts`, `src/agent/prompt/types.ts`, `src/agent/prompt/modules/runtime.ts`, `src/agent/agent-setup.ts`, `tests/host/ipc-handlers/sandbox-tools.test.ts`
**Outcome:** Success — all 2439 tests pass (5 new tests for workspace tier access via symlinks)
**Notes:** The sandbox provider also creates its own mountRoot for the agent subprocess — that's fine, the agent subprocess and the host-side tool handlers each get their own symlink layout pointing to the same real directories.

## [2026-03-14 12:05] — Create LocalSandboxDispatcher for lazy sandbox spawning

**Task:** Implement LocalSandboxDispatcher that mirrors NATSSandboxDispatcher pattern for local sandbox modes
**What I did:** Created `src/host/local-sandbox-dispatch.ts` with factory function pattern (closure-based, no `this` binding). For container types (apple/docker), lazily spawns sandbox on first `ensureSandbox()` call. For subprocess/seatbelt, `ensureSandbox()` is a no-op. Added `getSandboxProcess()` accessor for later integration. Created comprehensive test suite with 11 tests covering all sandbox types, reuse, release, and close.
**Files touched:** `src/host/local-sandbox-dispatch.ts` (created), `tests/host/local-sandbox-dispatch.test.ts` (created)
**Outcome:** Success — all 11 tests pass
**Notes:** Used closure pattern (not class) to match NATSSandboxDispatcher style. Delete from map before kill() in release() so hasSandbox returns false even on throw. Promise.allSettled in close() so one failure doesn't block others.
