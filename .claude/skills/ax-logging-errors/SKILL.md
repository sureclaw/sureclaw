---
name: ax-logging-errors
description: Use when modifying logging, error handling, or diagnostic messages — logger setup, transports, error diagnosis patterns in src/logger.ts and src/errors.ts
---

## Overview

AX uses a custom structured logger with dual transports (console + file) and an error diagnosis system that maps common failure patterns to human-readable suggestions. The logger is a singleton initialized once at startup.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/logger.ts` | Structured logger with console + file transports | `initLogger()`, `getLogger()`, `Logger`, `LogLevel` |
| `src/errors.ts` | Error pattern matching and user-facing diagnosis | `diagnoseError()`, `formatDiagnosedError()`, `DiagnosedError` |

## Logger

### Initialization

```typescript
initLogger({ level?: LogLevel, pretty?: boolean, component?: string });
```

- **level**: `'debug' | 'info' | 'warn' | 'error' | 'fatal'` (default: `'info'`, overrideable via `LOG_LEVEL` env)
- **pretty**: Color-coded compact output if `true` (default: auto-detect TTY)
- **component**: Optional subsystem name. When set, the logger checks `LOG_LEVEL_<COMPONENT>` (uppercased, hyphens → underscores) before falling back to `LOG_LEVEL`. The name is also bound as a default field on every emitted line.
- **AX_VERBOSE**: Set `AX_VERBOSE=1` to enable verbose (debug-level) logging. This is the unified verbose flag — replaces various per-component debug flags. Used in `src/cli/index.ts` to set log level to debug at startup.

### Per-component log levels (`LOG_LEVEL_*`)

When one subsystem is misbehaving, an operator should be able to crank up its verbosity without drowning the rest of the host. Set `LOG_LEVEL_<COMPONENT>` to override the default `LOG_LEVEL` for a single component:

```bash
LOG_LEVEL=info LOG_LEVEL_SANDBOX_K8S=debug ax serve
```

**Convention:** uppercase + replace `-` with `_`, prefix with `LOG_LEVEL_`. So `sandbox-k8s` → `LOG_LEVEL_SANDBOX_K8S`. The mapping happens automatically — no allowlist, no registration.

**Resolution priority** (most specific wins):
1. Explicit `level` option in `createLogger({ level })` — caller intent always wins.
2. `LOG_LEVEL_<COMPONENT>` env var — operator override for one subsystem.
3. `LOG_LEVEL` env var — global default.
4. `'info'` — built-in fallback.

The override applies to every logger created via `createLogger({ component: 'foo-bar' })` AND every child logger created via `getLogger().child({ component: 'foo-bar' })`. The codebase uses the `child()` form ubiquitously — see `src/host/orchestrator.ts`, `src/host/server-completions.ts`, `src/providers/sandbox/k8s.ts`, etc.

### Logging hygiene philosophy (Task 7, 2026-04-22)

The user complaint pre-Task 7 was "extremely unreliable... so much logging that useful signal gets lost." The new philosophy:

- **One canonical line per chat** at info or error: `chat_complete` (success) or `chat_terminated` (failure). What operators scan.
- **Step-level events at debug.** Useful when bumping verbosity for one component; otherwise noise.
- **Recoverable failures (chat continues with degraded behavior) → info, not warn.** Examples: `host_git_sync_failed`, `host_identity_fetch_failed`, `memory_recall_error`. The chat still proceeds; the failure is informational.
- **Per-attempt failures inside retry loops → info, not warn.** Examples: `agent_response_error`. The chat may still succeed after retry — only the terminal `chat_terminated` is chat-fatal.
- **Chat-fatal events at the sandbox layer → error.** Examples: `pod_failed`, `pod_watch_error`, `pod_timeout`, `pod_create_failed`. The host's retry loop may mask these with a successful retry; the sandbox-side error log is the per-attempt record.
- **Cleanup/operational warnings stay warn.** Examples: `pod_cleanup_failed` (real cleanup failures, not 404), `sandbox_state_unavailable_fallback`, `tcp_bind_failed`.

When in doubt: would an operator paged at 3 AM care? If yes → error or warn. If only useful when debugging one specific chat → debug.

### Transports

1. **Console** -- Level-configurable, pretty or JSON format
2. **File** -- Always debug level, JSONL format to `~/.ax/data/ax.log`

### Usage

```typescript
const log = getLogger();
log.info('server_listening', { port: 3000 });
const reqLog = log.child({ reqId: 'abc-123' });
```

## Error Diagnosis

### DiagnosedError

```typescript
interface DiagnosedError {
  raw: string;         // Original error message
  diagnosis: string;   // Human-readable explanation
  suggestion: string;  // Actionable fix
  logHint: string;     // Path to ax.log for details
}
```

### Patterns

| Pattern | Diagnosis | Suggestion |
|---|---|---|
| `ETIMEDOUT` | Network timeout | Check connectivity / proxy settings |
| `ECONNREFUSED` | Connection refused | Check if service is running |
| `ECONNRESET` | Connection reset | Retry or check network stability |
| `ENOTFOUND` | DNS lookup failed | Check URL / network config |
| `EPERM` | Permission denied (agent spawn/kill) | Check sandbox config, tsx wrapper |
| `401` | Authentication failed | Check API key / OAuth token |
| `403` | Forbidden | Check permissions / API access |
| `429` | Rate limited | Reduce request frequency |
| `50x` | Server error | Retry later |
| `CERT/SSL/TLS` | TLS handshake failed | Check certificates / proxy config |
| (fallback) | Unexpected error | See log file for details |

**Agent spawn errors**: Improved diagnosis for process signal handling (SIGKILL, SIGTERM) and EPERM errors from tsx-wrapped agents. `formatDiagnosedError()` produces user-facing strings with diagnosis, suggestion, and log path.

## Chat Termination Events (`chat_terminated`)

When a chat turn dies abnormally — sandbox spawn fails, fast-path crashes, the agent's response times out or errors — call `logChatTermination(reqLogger, ...)` from `src/host/chat-termination.ts`. It emits a single `chat_terminated` event at error level with structured fields (`phase`, `reason`, optional `sandboxId` / `exitCode` / `details`). All host-side termination sites converge on this one event so operators can `grep chat_terminated` to find every chat-killing event in one place, then `grep <reqId>` to drill into a single chat across the lines that led up to it.

**Phases** (`TerminationPhase`): `spawn` | `dispatch` | `sandbox` | `wait` | `cleanup`. Keep this set small and stable — alerts will key on these values.

**Conventions:**
- Always pass a `reqLogger` (a child logger already bound to `reqId` / `sessionId`) so those fields ride along automatically.
- Optional fields that are `undefined` are stripped from the emitted payload — no literal `"undefined"` keys in the JSON.
- Inside retry loops (the `wait` phase), call `createWaitFailureTracker()` instead of `logChatTermination` directly. The tracker collects per-attempt failure causes (`tracker.record({reason, details})`) and emits `chat_terminated` exactly once when the loop terminates (`tracker.emitTerminal(reqLogger, {phase, reason, sandboxId, exitCode, details})`). The recorded cause wins over the supplied terminal reason — so a chat that times out and exhausts retries surfaces `agent_response_timeout`, not the generic `agent_failed`. A chat that fails-then-succeeds emits ZERO terminal events (correct — the chat ultimately succeeded). See `src/host/server-completions.ts` retry loop (~line 1805) for the canonical wire-up.
- The k8s sandbox provider does NOT call `logChatTermination` directly — it only has `podLog` (no host-layer reqLogger). The host detects pod death via the retry loop's terminal `agent_failed` branch (`server-completions.ts` ~line 2080), which fires `chat_terminated` with the pod name as `sandboxId`. The k8s side independently emits `pod_failed` with `terminationCause` (Task 3) for sandbox-side visibility.

## Canonical Chat-Outcome Events (`chat_complete` + `chat_terminated`)

Every chat turn produces EXACTLY ONE canonical line for operator triage — `chat_complete` (info) on the happy path, `chat_terminated` (error) on failure. Same field shape so a single grep covers both:

```
kubectl logs ax-host | grep "chat_complete\|chat_terminated"
```

`logChatComplete(reqLogger, { sessionId, agentId?, durationMs, phases?, sandboxId? })` from `src/host/chat-termination.ts` is the success-side helper. It's emitted automatically by the `attach` wrapper inside `processCompletion` — every successful return path goes through `attach`, so a future contributor adding a new return path can't forget the event. The wrapper gates its emit on a single `chatTerminated` flag set by `markTerminated()` at every termination site, so a chat that already logged `chat_terminated` (including from the outer catch in `processCompletion`) doesn't also emit `chat_complete`.

**Phase timing** (`phases: { scan, dispatch, agent, persist }`): coarse wall-clock buckets that let an operator see at a glance whether a slow chat was slow because of LLM latency vs storage vs catalog setup. Sub-second accuracy is fine — this is triage telemetry, not a benchmark.

- `scan` — inbound security scan + dequeue
- `dispatch` — workspace + git + identity + skill snapshot + MCP discovery + catalog build + sandbox config (everything between scan and the agent retry loop). Collapsed in fast-path (no sandbox spawn) so a fast-path turn shows `phases: { scan, agent, persist }` with no `dispatch`.
- `agent` — sandbox spawn + IPC handshake + LLM wait + retries (i.e. all wall-clock waiting for the LLM)
- `persist` — outbound scan + memorize + conversation history append + session title generation

**Wiring requirements when adding a new chat-termination site:**
1. Call `logChatTermination(reqLogger, {...})` (or `tracker.emitTerminal(...)`) AND immediately call `markTerminated()` so the success-side `chat_complete` doesn't fire on top of it.
2. If your termination site `throw`s rather than `return`s, set the flag BEFORE the throw — but the outer catch in `processCompletion` is also wired (gated `logChatTermination` + `markTerminated`) so an unhandled throw is still recorded as exactly-one canonical event.

**Audited duplicates (Task 5, 2026-04-22):**
- `fast_path_error` log: REMOVED — `chat_terminated` carries the same `error` plus phase/reason. Operators grep `chat_terminated` and filter on `reason: 'fast_path_error'`.
- `agent_response_error` log: KEPT (now at info per Task 7) — per-attempt visibility distinct from chat termination. Useful for diagnosing chats that succeed after retry. Demoted from warn → info because per-attempt failures are not chat-fatal.
- `agent_response_timeout` chat_terminated emit at server.ts safety-timer: REMOVED — the timer's rejection flows into the retry loop's catch, where the tracker records the cause; the single emit at the terminal `agent_failed` branch names it. Avoids stale terminal events when timeout fires but a retry succeeds.
- `pod_failed` log (k8s.ts): KEPT (now at error per Task 7) — sandbox-side visibility, distinct subsystem. Promoted from warn → error because pod death is chat-fatal at the sandbox layer (even if the host retry masks it). Operators correlate via `sandboxId` / `podName`.

**Level reclassifications (Task 7, 2026-04-22):**
- Demoted to debug (happy-path step events): `completion_start`, `scan_inbound` (clean), `inbound_clean`, `dequeue_failed`, `workspace_reuse`, `agent_response_received`, `agent_spawn`. (Most were already at debug pre-Task 7 — Task 7 just confirmed.)
- Demoted warn → info (recoverable, chat continues): `host_git_sync_failed`, `host_identity_fetch_failed`, `memory_recall_error`, `agent_response_error`.
- Promoted warn → error (chat-fatal at sandbox layer): `pod_failed`, `pod_watch_error`, `pod_timeout`. (`pod_create_failed` was already at error.)
- Kept at warn: `pod_cleanup_failed` (real cleanup failures, not 404), `sandbox_state_unavailable_fallback`, `scan_inbound` (status: blocked).

## Common Tasks

**Adding a new error pattern:**
1. Add regex + diagnosis + suggestion entry to the patterns array in `errors.ts`
2. Add test in `tests/errors.test.ts`

**Adding a new chat-termination site:**
1. Import `logChatTermination` from `src/host/chat-termination.js` (or `createWaitFailureTracker` if the site is inside a retry loop).
2. Pick the right `phase` (or add a new one to `TerminationPhase` if truly needed — and update alerts).
3. Call it with a stable `reason` string and any `details` you'd want at 3 AM.
4. Add a test asserting the event fires EXACTLY ONCE per terminated chat (not per attempt).

## Gotchas

- **Underscore keys in log messages**: Use `'server_listening'` not `'server listening'`.
- **File transport is always debug**: Even if console level is `'error'`.
- **`getLogger()` before `initLogger()` returns a no-op**: Always call `initLogger()` at startup.
- **Error diagnosis is best-effort**: Unknown errors get a generic fallback.
- **Don't use `console.log` directly**: Always use the logger for structured output.
- **EPERM on agent kill**: tsx-wrapped agents may throw EPERM when receiving signals. The error handler wraps kill in try/catch.
- **Read-only filesystem handling**: The logger gracefully skips the file transport when the filesystem is read-only (e.g., container environments). No crash on write failure — it silently falls back to console-only logging.
