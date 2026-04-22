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
initLogger({ level?: LogLevel, pretty?: boolean });
```

- **level**: `'debug' | 'info' | 'warn' | 'error' | 'fatal'` (default: `'info'`, overrideable via `LOG_LEVEL` env)
- **pretty**: Color-coded compact output if `true` (default: auto-detect TTY)
- **AX_VERBOSE**: Set `AX_VERBOSE=1` to enable verbose (debug-level) logging. This is the unified verbose flag — replaces various per-component debug flags. Used in `src/cli/index.ts` to set log level to debug at startup.

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

**Audited duplicates (Task 5, 2026-04-22):**
- `fast_path_error` log: REMOVED — `chat_terminated` carries the same `error` plus phase/reason. Operators grep `chat_terminated` and filter on `reason: 'fast_path_error'`.
- `agent_response_error` warn log: KEPT — per-attempt visibility distinct from chat termination (warn level vs error level). Useful for diagnosing chats that succeed after retry.
- `agent_response_timeout` chat_terminated emit at server.ts safety-timer: REMOVED — the timer's rejection flows into the retry loop's catch, where the tracker records the cause; the single emit at the terminal `agent_failed` branch names it. Avoids stale terminal events when timeout fires but a retry succeeds.
- `pod_failed` warn log (k8s.ts): KEPT — sandbox-side visibility, distinct subsystem. Operators correlate via `sandboxId` / `podName`.

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
