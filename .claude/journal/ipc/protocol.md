# IPC: Protocol

IPC protocol enhancements: heartbeat keep-alive.

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
