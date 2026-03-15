# IPC: Protocol

IPC protocol enhancements: heartbeat keep-alive, schema hardening.

## [2026-03-15 15:35] — Fix concurrent IPC call response misrouting

**Task:** Debug why the web UI showed no response when user said "hi" — agent's second LLM call returned empty text
**What I did:** Root-caused to IPC client using per-call `data` handlers on a shared socket. When pi-coding-agent executed multiple tool calls concurrently (identity x2, memory x1), all handlers received the first response, resolved, and removed themselves. Subsequent responses were misrouted to the next LLM call, which parsed an identity_read response as an LLM response (no `chunks` → empty text). Fixed by adding `_msgId` correlation: client generates a unique ID per call, host echoes it in responses/heartbeats, client routes responses by ID using a single shared data handler.
**Files touched:** `src/agent/ipc-client.ts` (major refactor: shared data handler + pending map), `src/host/ipc-server.ts` (echo `_msgId` in responses/heartbeats, strip before Zod validation), `tests/agent/ipc-client.test.ts` (added concurrent test), `tests/agent/ipc-client-reconnect.test.ts`, `tests/agent/runner.test.ts`, `tests/agent/session.test.ts`, `tests/agent/runners/pi-session.test.ts` (all mock servers updated to echo `_msgId`)
**Outcome:** Success — all 2401 tests pass (1 pre-existing unrelated failure)
**Notes:** The bug was intermittent in production because it required concurrent IPC calls (multiple tool_use in a single LLM response). Sequential tool calls worked fine.

## [2026-03-14 11:54] — Restore workspace_write IPC schema

**Task:** Add `workspace_write` IPC schema as part of lazy-sandbox decoupling effort
**What I did:** Added `WorkspaceWriteSchema` to `src/ipc-schemas.ts` using `ipcAction()` with tier (agent|user), path, and content fields. Added tests in `tests/ipc-schemas-enterprise.test.ts` for valid input and invalid tier rejection. Added `workspace_write` to enterprise actions registry test. Also added `workspace_write` to `knownInternalActions` in `tests/agent/tool-catalog-sync.test.ts` to pass sync test (will be moved to tool catalog in Task 3).
**Files touched:** `src/ipc-schemas.ts`, `tests/ipc-schemas-enterprise.test.ts`, `tests/agent/tool-catalog-sync.test.ts`
**Outcome:** Success — all targeted tests pass (20/20)
**Notes:** Schema follows existing patterns: `safeString(1024)` for path, `safeString(500_000)` for content (matching SandboxWriteFileSchema), `z.enum(['agent', 'user'])` for tier.

## [2026-03-03 02:50] — Address PR #48 review comments on ipc-schemas.ts

**Task:** Address unresolved review comment on src/ipc-schemas.ts from PR #48
**What I did:**
- Extracted duplicated agent state enum values into a shared `agentStates` const and `agentStateEnum` in `AgentOrchListSchema`
- Changed `policyTags` items from bare `z.string().max(50)` to `safeString(50)` for null-byte validation consistency
- Changed `payload` record keys from `z.string()` to `safeString(200)` for consistency with `headers` record
- Changed `eventType` from bare `z.string()` to `safeString(200)` for length/null-byte validation
- Added `.min(0)` bound to `since` number field in `AgentOrchTimelineSchema`
**Files touched:** `src/ipc-schemas.ts`
**Outcome:** Success — all 2147 tests pass (200 test files)
**Notes:** The other two PR #48 review comments (on orchestration.ts and orchestrator.ts) were already addressed by commit 2e6cf08 and marked "Outdated" on GitHub. Only ipc-schemas.ts had an unresolved comment.

## [2026-02-27 10:29] — IPC Heartbeat Keep-Alive

**Task:** Implement heartbeat mechanism for IPC so long-running operations don't time out
**What I did:**
- Server (`ipc-server.ts`): Added `HEARTBEAT_INTERVAL_MS` (15s) export and heartbeat interval around handler execution in `createIPCServer`. Server sends `{_heartbeat: true, ts}` frames during handler execution.
- Client (`ipc-client.ts`): Rewrote `onData` in `callOnce()` to process multiple frames in a `while` loop, recognize `_heartbeat` frames (reset timeout timer), and resolve on actual response. Changed `const timer` to `let timer`. Updated timeout error message to mention heartbeats.
- Tool catalog (`tool-catalog.ts`): Removed `timeoutMs` from `agent_delegate` (was 10min) and `image_generate` (was 2min) — heartbeats eliminate the need for static overrides.
- Tests: Added 4 new heartbeat tests in `ipc-client.test.ts`, 2 tests in `ipc-server.test.ts`, updated 2 tests in `ipc-tools.test.ts`.
**Files touched:** `src/host/ipc-server.ts`, `src/agent/ipc-client.ts`, `src/agent/tool-catalog.ts`, `tests/agent/ipc-client.test.ts`, `tests/host/ipc-server.test.ts`, `tests/agent/ipc-tools.test.ts`
**Outcome:** Success — all 1736 tests pass (167 test files)
**Notes:** Design mirrors openclaw pattern (tick events every 15s, 2x watchdog = 30s default client timeout). For fast operations (<15s), interval never fires — zero overhead.
