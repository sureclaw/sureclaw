# Host: Orchestration

Agent orchestration system: supervisor, directory, agent-loop, event store, heartbeat, policy tags.

## [2026-04-18 13:42] — Hook syncToolModulesForSkill into approveSkillSetup (Task 3 of tool-modules-git-native)

**Task:** Wire the Task-2 tool-module sync helper into the skill-approval admin flow so a successful approval that reaches `kind: 'enabled'` and declares MCP servers triggers a commit of `.ax/tools/<skill>/` modules into the agent's workspace repo. Errors must not fail the approval.
**What I did:** Added `syncToolModules` as a required dep on `ApproveDeps` + `AdminDeps` (fail-loud contract — test fixtures get a stub). After step 9 (read fresh state), the helper calls `loadSnapshot`, finds the skill's frontmatter, and invokes the closure if `mcpServers.length > 0` + `state.kind === 'enabled'`. Result merges into the audit `args` payload as `toolSync: { moduleCount, toolCount, commit }` on success or `toolSyncError: <msg>` on failure. Constructed the closure in `initHostCore` bound to `mcpManager`, `skillCredStore`, and `providers.workspace`; threaded through `HostCore → server.ts → setupAdminHandler → createAdminHandler → approveSkillSetup`. Added 6 new tests: calls with correct input, skips when no MCP servers, skips when still pending, audit success shape, audit error shape, threads authenticated userId.
**Files touched:** src/host/server-admin-skills-helpers.ts, src/host/server-admin.ts, src/host/server-init.ts, src/host/server-webhook-admin.ts, src/host/server.ts, tests/host/server-admin-skills.test.ts (6 new tests + stub), tests/host/server-admin.test.ts, tests/host/server-admin-oauth-start.test.ts, tests/host/server-admin-oauth-providers.test.ts (stubs for new required dep)
**Outcome:** Success — `npm run build` clean, 83 admin-test-file tests pass, 105 skills tests pass. Pre-existing socket-path integration failures on main are unrelated.
**Notes:** Dropped the explicit `snapshotCache.invalidateAgent` call that used to run between step 8 and step 10 — the cache is keyed on `(agentId, HEAD sha)` and the projection reads DB rows live, so writing new creds/domains doesn't invalidate the cached snapshot. `getAgentSkills` still reads fresh.

## [2026-03-24 09:15] — Status SSE events for workspace and sandbox provisioning

**Task:** Surface long-running backend operations (workspace mount, sandbox spawn) to frontend via SSE status events
**What I did:** Added status event emissions in server-completions.ts (workspace downloading/ready, sandbox creating/retrying), forwarding in server-request-handlers.ts as named SSE, frontend transport parsing in ax-chat-transport.ts, runtime wiring through useAxChatRuntime/App.tsx, and dynamic display in Thread component replacing hardcoded "Thinking..."
**Files touched:** src/host/server-completions.ts, src/host/server-request-handlers.ts, ui/chat/src/lib/ax-chat-transport.ts, ui/chat/src/lib/useAxChatRuntime.tsx, ui/chat/src/App.tsx, ui/chat/src/components/thread.tsx, tests/host/server-completions-status-events.test.ts (new), tests/host/server-request-handlers-status.test.ts (new), tests/host/server.test.ts (fix)
**Outcome:** Success — 227 test files, 2566 tests all passing
**Notes:** Had to fix server.test.ts SSE streaming test — status events added extra data: lines that shifted expected indices. Fixed by filtering to only OpenAI-format chunks.

## [2026-03-01 10:12] — Suppress noisy invalid_state_transition warnings in auto-state

**Task:** Fix `invalid_state_transition from=tool_calling to=tool_calling` warnings flooding logs when LLM makes parallel tool calls
**What I did:**
- Added state guards in `enableAutoState()` to skip no-op transitions (same state → same state)
- For the `tool.call` case when already `tool_calling`, update the activity label and record heartbeat activity directly (so heartbeat stays alive without a redundant state transition)
**Files touched:** `src/host/orchestration/orchestrator.ts`
**Outcome:** Success — build clean, all 1983 tests pass
**Notes:** Multiple tool.call events in one LLM turn are normal (parallel tool use). The first transitions to tool_calling, subsequent ones just update the activity label.

## [2026-03-01 10:10] — Fix heartbeat killing active fire-and-forget delegates

**Task:** Diagnose and fix heartbeat_timeout killing delegated agents that are actively working (tool calls, LLM streaming)
**What I did:**
- Diagnosed two root causes: (1) `enableAutoState()` was never called in server.ts, so auto-state inference never ran in production. (2) Fire-and-forget handle was registered with parent's sessionId, but child agent events use a different requestId — sessionToHandles lookup always missed.
- Added `requestId?: string` to `DelegateRequest` interface in `src/host/ipc-server.ts`
- Modified `delegation.ts` fire-and-forget path: generates `childRequestId`, sets it on `delegateReq.requestId`, registers handle with `sessionId: childRequestId`
- Modified `server.ts` `handleDelegate`: uses `req.requestId` if provided
- Called `orchestrator.enableAutoState()` in `server.ts` after orchestrator creation, with cleanup on shutdown
- Added 3 regression tests: requestId alignment, auto-state heartbeat update, blocking backward compat
**Files touched:** `src/host/ipc-server.ts`, `src/host/ipc-handlers/delegation.ts`, `src/host/server.ts`, `tests/host/delegation-hardening.test.ts`
**Outcome:** Success — build clean, all 1983 tests pass
**Notes:** The fix ensures child events flow through auto-state → supervisor.transition → agent.state event → heartbeat monitor, keeping the heartbeat alive for the entire delegation.

## [2026-03-01 07:00] — Fix spawning→completed invalid state transition in fire-and-forget delegation

**Task:** Fix `invalid_state_transition from=spawning to=completed` warnings when fire-and-forget delegates complete
**What I did:** Added `orchestrator.supervisor.transition(handle.id, 'running', ...)` immediately after `orchestrator.register()` in the fire-and-forget path, so the handle goes `spawning → running → completed` instead of trying the invalid `spawning → completed`. Updated test mocks to start at `spawning` state and assert the `running` transition happens.
**Files touched:** src/host/ipc-handlers/delegation.ts, tests/host/delegation-hardening.test.ts
**Outcome:** Success — build clean, 24 delegation tests pass
**Notes:** The orchestrator state machine only allows `spawning → {running, failed, canceled}`. The delegation handler was skipping the `running` transition because it registered the handle and immediately launched the background delegate without updating state.

## [2026-03-01 02:05] — Fix PR review issues for orchestration enhancements

**Task:** Resolve 3 review conversations on PR #48: (P1) dispatcher integration missing, (P1) caller identity resolution flaw, (P2) session-to-handle mapping overwrites
**What I did:**
1. Wired `createOrchestrationHandlers` into `createIPCHandler` via optional `opts.orchestrator` parameter
2. Fixed `resolveCallerHandle` — changed `||` to `&&` with non-terminal check so multi-agent sessions resolve correctly
3. Changed `sessionToHandle` Map<string,string> to `sessionToHandles` Map<string,Set<string>> to support multiple handles per session
4. Added tests: new `tests/host/ipc-handlers/orchestration.test.ts` (5 tests), 2 new tests in `orchestrator.test.ts`
**Files touched:**
- Modified: `src/host/ipc-server.ts` (import + wire orchestration handlers)
- Modified: `src/host/ipc-handlers/orchestration.ts` (fix resolveCallerHandle)
- Modified: `src/host/orchestration/orchestrator.ts` (session→handles 1:N mapping)
- Modified: `tests/host/orchestration/orchestrator.test.ts` (2 new autoState tests)
- Modified: `tests/integration/cross-component.test.ts` (updated comment)
- Created: `tests/host/ipc-handlers/orchestration.test.ts` (5 handler tests)
**Outcome:** Success — all 184 test files pass (1972 tests), TypeScript build clean
**Notes:** The `resolveCallerHandle` bug was subtle — `bySession()` pre-filters by session, making the `||` always true and returning first candidate regardless of agentId. The fix uses `&&` with agentId match + non-terminal state check.

## [2026-03-01 01:00] — Orchestration Enhancements (4 features)

**Task:** Implement four orchestration enhancements from docs/plans/2026-02-28-orchestration-enhancements.md: persistent event store, heartbeat liveness monitor, policy tags on inter-agent messages, and wall-clock timeout for agent loops.
**What I did:**
- Merged the `claude/agent-orchestration-architecture-eppZW` base branch (resolved journal conflict)
- **Persistent Event Store:** Created `src/migrations/orchestration.ts` (Kysely migration for `orchestration_events` table with 5 indexes), `src/host/orchestration/event-store.ts` (SQLite-backed store that subscribes to EventBus and auto-captures agent.* events), and 14 tests covering append/query/filter/capture
- **Heartbeat Liveness Monitor:** Created `src/host/orchestration/heartbeat-monitor.ts` (subscribes to EventBus for proof-of-life, periodic check interval auto-interrupts stuck agents), and 9 tests covering activity tracking, timeout detection, terminal/interrupted agent skip, reset on activity
- **Policy Tags:** Added `policyTags?: readonly string[]` to `AgentMessage` type, updated `send()`/`broadcast()` in orchestrator to pass through tags, added `policyTags` field to `AgentOrchMessageSchema` in IPC schemas, updated IPC handler to pass tags, 3 tests for send/broadcast/backward-compat
- **Wall-Clock Timeout:** Added `maxWallClockMs` to `AgentLoopConfig`, `wall_clock_timeout` to reason/status enums, deadline checks before and after each iteration in `runAgentLoop()`, 3 tests covering timeout, non-interference, and event emission
- Wired event store + heartbeat into orchestrator (new constructor param, shutdown cleanup)
- Added types (`OrchestrationEvent`, `EventFilter`, `OrchestrationEventStore`, `HeartbeatMonitorConfig`) to types.ts
- Added `AgentOrchTimelineSchema` to IPC schemas and timeline handler to IPC handlers
- Fixed `z.record(z.unknown())` → `z.record(z.string(), z.unknown())` for Zod v4 compat
- Updated `tool-catalog-sync.test.ts` and `cross-component.test.ts` to register orchestration IPC actions as internal-only
**Files touched:**
- Created: `src/migrations/orchestration.ts`, `src/host/orchestration/event-store.ts`, `src/host/orchestration/heartbeat-monitor.ts`
- Created: `tests/host/orchestration/event-store.test.ts`, `tests/host/orchestration/heartbeat-monitor.test.ts`
- Modified: `src/host/orchestration/types.ts`, `src/host/orchestration/orchestrator.ts`, `src/host/orchestration/agent-loop.ts`
- Modified: `src/ipc-schemas.ts`, `src/host/ipc-handlers/orchestration.ts`
- Modified: `tests/host/orchestration/orchestrator.test.ts`, `tests/host/orchestration/agent-loop.test.ts`
- Modified: `tests/agent/tool-catalog-sync.test.ts`, `tests/integration/cross-component.test.ts`
**Outcome:** Success — all 182 test files pass (1943 tests), TypeScript build clean
**Notes:** The base branch's `z.record(z.unknown())` was broken under Zod v4 (needs key type). Fixed as part of this work. Orchestration IPC actions are host-internal and not exposed in the agent tool catalog.

## [2026-02-28 16:20] — Add Ralph Wiggum Loop (agent-loop.ts)

**Task:** Add support for the Ralph Wiggum pattern — iterative agent execution with fresh context and external validation.
**What I did:**
- Implemented `runAgentLoop()` in `src/host/orchestration/agent-loop.ts`
- Each iteration: spawn agent with fresh context → run → validate externally → retry or pass
- Key features: fresh context per iteration (no history accumulation), configurable validation function, customizable retry prompt builder, progress callbacks, interrupt-aware, loop events on EventBus
- Each iteration tracked as a separate AgentHandle with `pattern: 'ralph'` metadata
- Default retry prompt builder appends validation failure info to original prompt
- Wrote 13 tests covering: first-pass success, retry until pass, max iterations, fresh handles per iteration, custom retry prompts, progress callbacks, event bus emissions, execute/validate error handling, interrupt support, metadata tagging, duration tracking
**Files touched:**
- Created: `src/host/orchestration/agent-loop.ts`
- Created: `tests/host/orchestration/agent-loop.test.ts`
**Outcome:** Success — 105 total orchestration tests pass (92 + 13 new)
**Notes:** The loop is a workflow primitive that sits on top of the Orchestrator, not inside it. The execute/validate functions are injected by the caller, making it agnostic to how agents are actually spawned (processCompletion, delegation, etc.).

## [2026-02-28 15:50] — Agent Orchestration Architecture

**Task:** Design and implement an agent orchestration system that enables real-time visibility into active agents, agent state tracking, interrupt mechanisms, and agent-to-agent communication.
**What I did:**
- Researched OpenClaw's Agent Teams RFC, Google A2A protocol, Confluent's event-driven patterns, OpenAI Agents SDK handoff model, and LangGraph state machines
- Designed a hybrid orchestration architecture: centralized governance (Orchestrator) with decentralized messaging (peer-to-peer through host)
- Implemented three new modules in `src/host/orchestration/`:
  - `types.ts` — Agent state machine (10 states, validated transitions), AgentHandle, AgentMessage, scoping types
  - `agent-supervisor.ts` — Lifecycle management with interrupt/grace-period/cancel, max-agent safety valve, audit logging
  - `agent-directory.ts` — Runtime discovery with multi-dimensional queries (by session, user, parent), tree builder, session summaries
  - `orchestrator.ts` — Central coordinator: message routing, mailbox system (push + pull), scoped broadcast, auto-state inference from existing EventBus events
- Added IPC handler (`src/host/ipc-handlers/orchestration.ts`) with session-scoped access control
- Added 6 new IPC schemas for orchestration actions
- Wrote 92 tests covering all modules
**Files touched:**
- Created: `docs/plans/2026-02-28-agent-orchestration-architecture.md`
- Created: `src/host/orchestration/types.ts`, `agent-supervisor.ts`, `agent-directory.ts`, `orchestrator.ts`
- Created: `src/host/ipc-handlers/orchestration.ts`
- Modified: `src/ipc-schemas.ts` (added 6 orchestration action schemas)
- Created: `tests/host/orchestration/agent-supervisor.test.ts`, `agent-directory.test.ts`, `orchestrator.test.ts`
**Outcome:** Success — 92 new tests pass, existing IPC schema tests unaffected
**Notes:** Key design decisions: (1) Extend EventBus rather than replace it — auto-state inference bridges existing llm.start/tool.call events to the new state model. (2) Messages always flow through trusted host — preserves sandbox security boundary. (3) A2A-inspired state machine with 10 states and enforced transitions. (4) Both push (listeners) and pull (polling) message delivery — sandboxed agents use pull via IPC, internal components use push.
