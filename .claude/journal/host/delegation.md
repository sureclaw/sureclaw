# Host: Delegation

Subagent delegation pipeline: hardening, async parallel delegation, delegate_collect, consolidation.

## [2026-03-01 06:47] — Add `delegate_collect` tool for collecting fire-and-forget results

**Task:** The agent was using `sleep 15` to wait for `wait: false` delegates because there was no tool to collect results. The prompt referenced `agent_orch_status` for polling, but that's not exposed as an agent-side tool.
**What I did:**
- Added `AgentDelegateCollectSchema` to `src/ipc-schemas.ts` (handleIds + optional timeoutMs)
- Added `agent_delegate_collect` handler to `src/host/ipc-handlers/delegation.ts` — stores pending promises in a Map keyed by handleId, collect handler awaits all given handles and returns results
- Added `delegate_collect` tool to `src/agent/tool-catalog.ts` and `src/agent/mcp-server.ts`
- Updated delegation prompt to reference `delegate_collect` with example pattern instead of polling
- Added 5 tests: multi-handle collect, blocking behavior, unknown handles, error collection, cleanup after collect
- Fixed 4 test files with hardcoded tool counts (10→11): sandbox-isolation, ipc-tools, mcp-server, tool-catalog
**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-handlers/delegation.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/delegation.ts`, `tests/host/delegation-hardening.test.ts`, `tests/sandbox-isolation.test.ts`, `tests/agent/ipc-tools.test.ts`, `tests/agent/mcp-server.test.ts`, `tests/agent/tool-catalog.test.ts`
**Outcome:** Success — build clean, all 126 affected tests pass
**Notes:** Key design decision: `delegate_collect` blocks until all handles complete (no polling loop needed). The pending map is cleaned up after collection.

## [2026-03-01 07:00] — Consolidate delegate + delegate_collect into single `agent` tool

**Task:** Complete consolidation of two singleton delegation tools (`delegate`, `delegate_collect`) into a single `agent` tool with `type: "delegate"` and `type: "collect"` discriminators; rename IPC action `agent_delegate_collect` → `agent_collect`
**What I did:** Updated actionMap in tool-catalog.ts, handler key in delegation.ts, IPC schema in ipc-schemas.ts, MCP server mapping in mcp-server.ts. Fixed 6 test files (ipc-tools, tool-catalog, mcp-server, tool-catalog-sync, sandbox-isolation, delegation-hardening) for name/count changes.
**Files touched:** src/ipc-schemas.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts, src/host/ipc-handlers/delegation.ts, tests/agent/ipc-tools.test.ts, tests/agent/tool-catalog.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts, tests/host/delegation-hardening.test.ts
**Outcome:** Success — build clean, 126 tests pass across 6 test files
**Notes:** Consolidation follows the existing codebase pattern where multi-op tools use a `type` discriminator + `actionMap`. The `agent` tool now has `delegate` and `collect` as type values mapping to `agent_delegate` and `agent_collect` IPC actions respectively.

## [2026-03-01 00:00] — Add `wait` parameter to async-parallel-delegation plan

**Task:** Update the async-parallel-delegation plan to support sequential agent execution where one agent's output feeds the next
**What I did:** Added a `wait: boolean` parameter (default `false`) to `agent_delegate`. When `wait: true`, the handler blocks and returns `{response}` directly (current behavior). When `wait: false` or omitted, it fires-and-forgets with Orchestrator. Updated: Flow diagram (parallel + sequential examples), new IPC schema step, delegation handler branching logic, tool catalog description + param, prompt module with both patterns + decision rule, test cases (4 new sequential tests), Files Modified table.
**Files touched:** `.claude/plans/async-parallel-delegation.md`
**Outcome:** Success — plan now covers both parallel (fire-and-forget) and sequential (blocking) delegation patterns
**Notes:** The original plan only had fire-and-forget mode which would regress sequential workflows from 2 LLM turns to 4-6+ turns due to polling overhead. The `wait` parameter preserves backward-compatible blocking behavior while defaulting to async for parallelism gains.

## [2026-02-28 23:20] — Implement `wait` parameter for async parallel delegation

**Task:** Add `wait` parameter end-to-end: schema → handler → tool definition → prompt guidance, enabling fire-and-forget delegation with `wait: false`
**What I did:**
- Added `wait: z.boolean().optional()` to `AgentDelegateSchema` in `src/ipc-schemas.ts`
- Added `wait?: boolean` to `DelegateRequest` interface in `src/host/ipc-server.ts`
- Updated delegation handler (`src/host/ipc-handlers/delegation.ts`) to branch on `req.wait === false`: fire-and-forget returns `{handleId, status: "started"}` immediately, registers handle with orchestrator, launches delegate in background, stores result/error in handle metadata on completion
- Wired orchestrator in `src/host/server.ts` — create + pass to IPC handler + shutdown in `stopServer()`
- Added `wait` param to tool catalog (`src/agent/tool-catalog.ts`) and MCP server (`src/agent/mcp-server.ts`)
- Updated delegation prompt module (`src/agent/prompt/modules/delegation.ts`) with parallel vs sequential guidance
- Added 7 new tests in `tests/host/delegation-hardening.test.ts` covering: immediate return, background completion, explicit wait:true, omitted defaults to blocking, parallel execution, concurrency counter, orchestrator integration (success + failure)
**Files touched:** `src/ipc-schemas.ts`, `src/host/ipc-server.ts`, `src/host/ipc-handlers/delegation.ts`, `src/host/server.ts`, `src/agent/tool-catalog.ts`, `src/agent/mcp-server.ts`, `src/agent/prompt/modules/delegation.ts`, `tests/host/delegation-hardening.test.ts`
**Outcome:** Success — build clean, all 1975 tests pass across 184 test files
**Notes:** Default `wait: true` preserves backward compatibility. The orchestrator was already imported/typed in ipc-server.ts but not instantiated in server.ts — this change activates it.

## [2026-02-27 12:15] — Harden subagent delegation (fix 4 crash-causing bugs)

**Task:** Diagnose and fix "3 concurrent agents crashes the server" in the delegation pipeline.
**What I did:** Found and fixed 4 bugs: (1) IPC handler timer leak — setTimeout never cleared after handler completes, causing memory pressure under load; (2) Delegation handler error inconsistency — exceptions propagated to generic IPC catch instead of returning structured {ok:false, error}; (3) sessionCanaries map leak on error path — failed completions never cleaned up canary tokens; (4) Unhandled promise in IPC transport IIFE — stream.push() failures in the catch block caused agent crashes. Added 18 new tests (11 unit + 7 E2E) covering concurrent delegation, partial failure, rapid-fire stress, timer cleanup, and error response consistency.
**Files touched:** src/host/ipc-server.ts, src/host/ipc-handlers/delegation.ts, src/host/server-completions.ts, src/agent/ipc-transport.ts, tests/host/delegation-hardening.test.ts (new), tests/e2e/scenarios/delegation-stress.test.ts (new)
**Outcome:** Success — all 18 new tests pass, full suite green
**Notes:** The root cause of "3 agents crashes server" was a combination of timer leaks + error response inconsistency. Each IPC call leaked a 15-minute setTimeout; under 3 concurrent delegations making multiple IPC calls, timers accumulated fast. The delegation error handler also let exceptions propagate up, causing the IPC handler to return "Handler error: ..." instead of the expected {ok, error} shape.

## [2026-02-27 09:55] — Fix agent_delegate IPC timeout causing repeated subagent tasks

**Task:** Diagnose why subagents repeat the same tasks despite EPERM fix being in place.
**What I did:** Root-caused to IPC client 30-second default timeout. `agent_delegate` spawns subagents needing 30-60+ seconds, but the IPC call times out at 30s, returning "Error: IPC call timed out after 30000ms" to the LLM. The LLM interprets this as delegate failure and retries — creating repeated tasks. Added `timeoutMs` field to `ToolSpec` interface in tool catalog. Set 10-minute timeout for `agent_delegate` (matching max sandbox timeout) and 2-minute timeout for `image_generate`. Threaded timeout through both IPC tool creation paths (ipc-tools.ts and pi-session.ts).
**Files touched:** src/agent/tool-catalog.ts, src/agent/ipc-tools.ts, src/agent/runners/pi-session.ts, tests/agent/ipc-tools.test.ts
**Outcome:** Success — all 1731 tests pass. Subagents will no longer be re-delegated due to IPC timeout.
**Notes:** Evidence in the log was clear: gap between first and second `tool_execute name=agent_delegate` was exactly 30 seconds — the IPC timeout. LLM calls already had a 10-minute override (`LLM_CALL_TIMEOUT_MS`) but tool calls didn't.

## [2026-02-25 15:30] — Implement runner-configurable agent delegation

**Task:** Make agent_delegate a first-class agent tool with configurable runner and model, wire the onDelegate callback in server.ts
**What I did:**
1. Extended `AgentDelegateSchema` in ipc-schemas.ts with `runner` (enum) and `model` fields
2. Added `agent_delegate` to the tool catalog (TypeBox) and MCP server (Zod) — moved it from host-internal to agent-facing
3. Created `DelegateRequest` interface in ipc-server.ts, refactored `onDelegate` callback from `(task, context, ctx)` to `(req: DelegateRequest, ctx)`
4. Updated delegation handler to pass runner/model/maxTokens/timeoutSec through to onDelegate, and audit-log runner/model
5. Wired `handleDelegate` callback in server.ts using processCompletion with config overrides for runner and model
6. Added `delegation` config section to Config type and config schema (max_concurrent, max_depth)
7. Updated all test files: unit tests (ipc-delegation), e2e tests (agent-delegation), integration tests (phase2), sync tests (tool-catalog-sync), count tests (5 files)
8. Added 4 new tests: runner/model passing in unit and e2e, audit logging of runner/model, defaults-without-runner
**Files touched:**
- Modified: src/ipc-schemas.ts, src/types.ts, src/config.ts, src/host/ipc-server.ts, src/host/ipc-handlers/delegation.ts, src/host/server.ts, src/agent/tool-catalog.ts, src/agent/mcp-server.ts
- Modified tests: tests/host/ipc-delegation.test.ts, tests/e2e/harness.ts, tests/e2e/scenarios/agent-delegation.test.ts, tests/integration/phase2.test.ts, tests/agent/tool-catalog-sync.test.ts, tests/agent/tool-catalog.test.ts, tests/agent/ipc-tools.test.ts, tests/agent/mcp-server.test.ts, tests/sandbox-isolation.test.ts
**Outcome:** Success — 150/151 test files pass, 1515/1518 tests pass (2 pre-existing smoke test timeouts)
**Notes:** The key design decision was making delegation go through IPC to the host (not in-process within the agent). This means a pi-coding-agent parent can delegate to a claude-code child, or vice versa. The host controls spawning, sandbox isolation is preserved, and depth/concurrency limits are enforced server-side. The half-built infrastructure (handler + schema existed, but no tool catalog entry and no wired callback) was completed with minimal new code.
