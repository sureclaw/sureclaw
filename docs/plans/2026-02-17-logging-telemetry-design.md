# Logging & Telemetry Design

**Date:** 2026-02-17
**Status:** Approved

## Problem

AX has almost no visibility into what's happening under the hood. The specific trigger: on a slow/unreliable wifi connection, asking the agent something returned "error code 1" with zero additional information. The debug log didn't help either.

Root causes:
- Two separate logging systems (`createLogger()` for stdout events, `debug()` for file JSONL) that don't share context
- No request ID threading — can't correlate server logs, agent stderr, proxy errors, and IPC calls
- Errors swallowed silently (`catch {}`) throughout the codebase
- CLI shows generic messages like "Cannot connect to AX server" for all failures
- No log levels — can't control verbosity at runtime
- Pretty format is flat and hard to scan
- Bug: `logger.debug()` called in server.ts but doesn't exist on the Logger interface

## Solution

Replace both logging systems with a single **pino**-based logger. Add an error diagnosis layer that maps known error patterns to human-readable suggestions.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Application Code                       │
│  server.ts  proxy.ts  runner.ts  ipc-server.ts  cli/    │
│       │         │         │           │           │       │
│       └─────────┴─────────┴───────────┴───────────┘       │
│                         │                                 │
│              import { logger } from '../logger.js'        │
│                         │                                 │
│              ┌──────────┴──────────┐                      │
│              │   Logger Interface   │  ← OTel hooks here  │
│              │   (our abstraction)  │     later            │
│              └──────────┬──────────┘                      │
│                         │                                 │
│                    pino instance                          │
│                    │           │                           │
│              ┌─────┘           └─────┐                    │
│         dev: pretty formatter   file: ax.log              │
│         (color-coded compact)   (JSONL, always debug)     │
└──────────────────────────────────────────────────────────┘
```

**Key principle:** Call sites use our `Logger` interface, never import pino directly. OTel can be added later by injecting trace/span IDs at the interface layer.

## Logger Interface

```typescript
interface Logger {
  debug(msg: string, details?: Record<string, unknown>): void;
  info(msg: string, details?: Record<string, unknown>): void;
  warn(msg: string, details?: Record<string, unknown>): void;
  error(msg: string, details?: Record<string, unknown>): void;
  fatal(msg: string, details?: Record<string, unknown>): void;

  // Child logger with bound context (request ID, session ID, component)
  child(bindings: Record<string, unknown>): Logger;
}
```

No more separate `llm_call()`, `agent_spawn()`, etc. methods — those become `logger.info('agent_spawn', { sandbox, requestId })`.

## Console Output Format

Color-coded compact structured output. No icons — the whole line takes the color of its log level. Timestamp always gray, request ID always cyan.

```
12:34:56 [abc12345] agent_spawn  sandbox=bwrap                    ok
12:34:57 [abc12345] proxy_call   429 rate limited → retry 1/3     warn
12:34:59 [abc12345] proxy_call   200 OK  1.2s  850→320 tokens     ok
12:35:02 [abc12345] complete     4.1s  exit=0                     ok
```

Colors:
- **green** — info/ok lines
- **yellow** — warn lines
- **red** — error/fatal lines
- **gray** — debug lines, timestamps
- **cyan** — request IDs

## Request Context Threading

Every request creates a child logger:

```typescript
const reqLogger = logger.child({ reqId: requestId.slice(-8), sessionId });
reqLogger.info('completion_start', { contentLength: content.length });
// All subsequent logs from this request carry reqId automatically
```

The child logger is passed down through `processCompletion()` and into any functions that need to log within that request's context.

## Log Levels & Configuration

| Level | When | Example |
|---|---|---|
| `debug` | Granular tracing (IPC messages, validation steps, stream events) | `ipc_call messageCount=5 toolCount=3` |
| `info` | Normal lifecycle events | `agent_spawn sandbox=bwrap` |
| `warn` | Non-fatal issues, degraded conditions | `proxy_call 429 retry 1/3` |
| `error` | Failures that affect the user | `agent_failed exit=1 ETIMEDOUT` |
| `fatal` | Unrecoverable, process will exit | `Fatal: cannot bind socket` |

Control via:
- `LOG_LEVEL` env var (default: `info`)
- `--verbose` flag sets console to `debug`
- File transport always writes at `debug` level regardless of `LOG_LEVEL`

## Transports

| Transport | When | Format | Level |
|---|---|---|---|
| Console (custom pretty formatter) | Always | Color-coded compact structured | `LOG_LEVEL` / `info` default |
| File (`~/.ax/data/ax.log`) | Always | JSONL (machine-readable) | `debug` always |

The file transport replaces the current `debug()` function. Same path, same JSONL format, but now with proper log levels and request context in every line.

## Error Diagnosis Layer

New `src/errors.ts` module:

```typescript
interface DiagnosedError {
  raw: string;          // "ETIMEDOUT after 30000ms"
  diagnosis: string;    // "Network timeout reaching Anthropic API"
  suggestion: string;   // "Check your wifi/VPN connection"
  logHint: string;      // "Details: ~/.ax/data/ax.log"
}

function diagnoseError(err: Error | string): DiagnosedError;
```

Pattern table:

| Pattern | Diagnosis | Suggestion |
|---|---|---|
| `ETIMEDOUT` | Network timeout | Check wifi/VPN connection |
| `ECONNREFUSED` | Connection refused | Is the server running? (`ax serve`) |
| `ECONNRESET` | Connection dropped | Network instability, try again |
| `ENOTFOUND` | DNS resolution failed | Check internet connection |
| `EPIPE` / socket hangup | Connection closed unexpectedly | Server may have crashed, check logs |
| HTTP 401 | Authentication failed | Run `ax configure` to refresh credentials |
| HTTP 403 | Access denied | Check API key permissions |
| HTTP 429 | Rate limited | Wait and retry, or check usage limits |
| HTTP 500/502/503 | Upstream API error | Anthropic API may be down, check status.anthropic.com |
| TLS errors | SSL/TLS handshake failed | Check system clock, proxy/firewall settings |
| Unknown | Unexpected error | See log file for details |

Replaces `extractFailureReason()` in server.ts. Used at every user-facing error boundary: CLI send, CLI chat, server HTTP response.

## What Changes

| Current | After |
|---|---|
| `createLogger()` — stdout events | Removed, replaced by pino |
| `debug()` — file JSONL | Removed, replaced by pino file transport |
| `console.log('[server] ...')` in CLI | Uses logger |
| `console.error()` scattered | Uses `logger.error()` or `diagnoseError()` |
| `extractFailureReason()` | Replaced by `diagnoseError()` |
| `logger.debug()` bug in server.ts:607 | Fixed — debug level exists now |
| Silent `catch {}` blocks | Log at debug/warn level before swallowing |
| No request tracing | Every log line carries `reqId` via child loggers |

## OTel Upgrade Path

When ready:
1. `npm install @opentelemetry/api @opentelemetry/sdk-node`
2. In `createLogger()`, read `trace.getActiveSpan()` and inject `traceId`/`spanId` into pino bindings
3. Add span creation at request boundaries (server, agent spawn, proxy call)
4. Zero changes to call sites — same `Logger` interface

## Files Affected

- `src/logger.ts` — complete rewrite (pino-based, new interface, pretty formatter, file transport)
- `src/errors.ts` — new module (error diagnosis)
- `src/host/server.ts` — use new logger, child loggers per request, diagnoseError()
- `src/host/proxy.ts` — use new logger instead of debug()
- `src/host/ipc-server.ts` — use new logger instead of debug()
- `src/agent/runner.ts` — use new logger instead of debug()
- `src/agent/ipc-client.ts` — use new logger instead of debug()
- `src/agent/ipc-transport.ts` — use new logger instead of debug()
- `src/agent/runners/claude-code.ts` — use new logger instead of console.error()
- `src/agent/runners/pi-session.ts` — use new logger instead of debug()
- `src/cli/index.ts` — use new logger instead of console.log()
- `src/cli/send.ts` — use diagnoseError() for user-facing errors
- `src/cli/components/App.tsx` — use diagnoseError() for error messages
- `src/dotenv.ts` — use new logger instead of console.error()
- `src/providers/sandbox/subprocess.ts` — use new logger instead of console.warn()
- `src/providers/sandbox/docker.ts` — use new logger instead of console.warn()
- `src/providers/credentials/encrypted.ts` — use new logger instead of console.error()
- `src/providers/credentials/keychain.ts` — use new logger instead of console.warn()
- `package.json` — add pino + pino-pretty dependencies
- Tests for new logger, error diagnosis, and updated call sites
