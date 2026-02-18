# Logging & Telemetry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace dual logging system with unified pino-based logger, add error diagnosis, color-coded output, and request tracing.

**Architecture:** Single pino instance with two transports (pretty console + JSONL file). Our `Logger` interface wraps pino so call sites never import it directly. Error diagnosis function maps known patterns to human-readable suggestions at user-facing boundaries.

**Tech Stack:** pino, pino-pretty, vitest (tests)

---

### Task 1: Install pino dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install pino and pino-pretty**

Run: `npm install pino pino-pretty`

**Step 2: Verify install**

Run: `node -e "require('pino'); require('pino-pretty'); console.log('ok')"`
Expected: `ok`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add pino and pino-pretty dependencies"
```

---

### Task 2: Rewrite logger with pino backend

**Files:**
- Modify: `src/logger.ts`
- Modify: `tests/logger.test.ts`

**Step 1: Write failing tests for the new Logger interface**

Replace `tests/logger.test.ts` entirely. The new tests must cover:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'node:stream';

// We'll test via createLogger which returns our Logger interface

describe('Logger', () => {
  let lines: string[];
  let testStream: Writable;

  beforeEach(() => {
    lines = [];
    testStream = new Writable({
      write(chunk, _enc, cb) {
        // pino writes JSON lines
        const text = chunk.toString().trim();
        if (text) lines.push(text);
        cb();
      },
    });
  });

  it('should log info with message and details', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('agent_spawn', { sandbox: 'bwrap' });

    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(30); // pino info level
    expect(entry.msg).toBe('agent_spawn');
    expect(entry.sandbox).toBe('bwrap');
  });

  it('should log warn level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.warn('rate_limited', { status: 429 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(40); // pino warn level
    expect(entry.msg).toBe('rate_limited');
  });

  it('should log error level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.error('agent_failed', { exitCode: 1 });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(50);
    expect(entry.msg).toBe('agent_failed');
  });

  it('should log debug level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.debug('ipc_call', { action: 'llm_call' });

    const entry = JSON.parse(lines[0]);
    expect(entry.level).toBe(20);
  });

  it('should filter by log level', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'warn' });
    logger.debug('should_not_appear');
    logger.info('should_not_appear');
    logger.warn('should_appear');

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).msg).toBe('should_appear');
  });

  it('should create child logger with bound context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child = logger.child({ reqId: 'abc123', component: 'server' });
    child.info('request_start');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.component).toBe('server');
    expect(entry.msg).toBe('request_start');
  });

  it('should nest child logger context', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    const child1 = logger.child({ reqId: 'abc123' });
    const child2 = child1.child({ step: 'proxy' });
    child2.info('call');

    const entry = JSON.parse(lines[0]);
    expect(entry.reqId).toBe('abc123');
    expect(entry.step).toBe('proxy');
  });

  it('should include pid and timestamp', async () => {
    const { createLogger } = await import('../src/logger.js');
    const logger = createLogger({ stream: testStream, level: 'debug' });
    logger.info('test');

    const entry = JSON.parse(lines[0]);
    expect(entry.pid).toBe(process.pid);
    expect(entry.time).toBeDefined();
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/logger.test.ts`
Expected: FAIL — old `createLogger` has wrong signature

**Step 3: Rewrite `src/logger.ts`**

Replace `src/logger.ts` entirely:

```typescript
// src/logger.ts — Unified pino-based logger
//
// Single logger with two transports:
//   1. Console: color-coded compact structured output (pino-pretty or custom)
//   2. File: JSONL to ~/.ax/data/ax.log (always debug level)
//
// Call sites use our Logger interface, never import pino directly.
// This makes OTel upgrade a one-file change.

import pino from 'pino';
import type { Logger as PinoLogger, DestinationStream } from 'pino';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { styleText } from 'node:util';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface Logger {
  debug(msg: string, details?: Record<string, unknown>): void;
  info(msg: string, details?: Record<string, unknown>): void;
  warn(msg: string, details?: Record<string, unknown>): void;
  error(msg: string, details?: Record<string, unknown>): void;
  fatal(msg: string, details?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  /** Console log level. Default: 'info'. Use 'silent' to disable console. */
  level?: LogLevel;
  /** Override console output stream (for testing). */
  stream?: DestinationStream;
  /** Enable file transport to ~/.ax/data/ax.log. Default: true. */
  file?: boolean;
  /** Pretty print to console. Default: true when stdout is a TTY. */
  pretty?: boolean;
}

// ═══════════════════════════════════════════════════════
// Pretty formatter
// ═══════════════════════════════════════════════════════

const LEVEL_COLORS: Record<number, (s: string) => string> = {
  20: (s: string) => styleText('gray', s),       // debug
  30: (s: string) => styleText('green', s),      // info
  40: (s: string) => styleText('yellow', s),     // warn
  50: (s: string) => styleText('red', s),        // error
  60: (s: string) => styleText('red', s),        // fatal
};

const LEVEL_LABELS: Record<number, string> = {
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

// Keys to exclude from the details display
const SKIP_KEYS = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'name']);

function formatTimestamp(epoch: number): string {
  const d = new Date(epoch);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatDetails(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (SKIP_KEYS.has(k)) continue;
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return parts.join('  ');
}

export function prettyFormat(obj: Record<string, unknown>): string {
  const time = formatTimestamp(obj.time as number);
  const level = obj.level as number;
  const msg = obj.msg as string ?? '';
  const colorize = LEVEL_COLORS[level] ?? ((s: string) => s);

  // Extract reqId for the request ID column
  const reqId = obj.reqId as string | undefined;
  const reqCol = reqId ? styleText('cyan', `[${reqId}]`) + ' ' : '';

  const details = formatDetails(obj);
  const detailStr = details ? '  ' + details : '';

  const levelLabel = LEVEL_LABELS[level] ?? 'unknown';

  return `${styleText('gray', time)} ${reqCol}${colorize(`${msg}${detailStr}`)}  ${colorize(levelLabel)}\n`;
}

// ═══════════════════════════════════════════════════════
// Logger Factory
// ═══════════════════════════════════════════════════════

function getLogPath(): string {
  const home = process.env.AX_HOME || join(homedir(), '.ax');
  const dir = join(home, 'data');
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return join(dir, 'ax.log');
}

function wrapPino(p: PinoLogger): Logger {
  return {
    debug(msg, details) { details ? p.debug(details, msg) : p.debug(msg); },
    info(msg, details) { details ? p.info(details, msg) : p.info(msg); },
    warn(msg, details) { details ? p.warn(details, msg) : p.warn(msg); },
    error(msg, details) { details ? p.error(details, msg) : p.error(msg); },
    fatal(msg, details) { details ? p.fatal(details, msg) : p.fatal(msg); },
    child(bindings) { return wrapPino(p.child(bindings)); },
  };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  const usePretty = opts.pretty ?? process.stdout.isTTY ?? false;
  const useFile = opts.file ?? !opts.stream; // disable file when test stream is provided

  // Build transports
  const targets: pino.TransportTargetOptions[] = [];

  if (useFile) {
    targets.push({
      target: 'pino/file',
      options: { destination: getLogPath(), mkdir: true },
      level: 'debug', // file always captures everything
    });
  }

  // If a test stream is provided, use it directly (no transports)
  if (opts.stream) {
    const pinoInstance = pino({ level }, opts.stream);
    return wrapPino(pinoInstance);
  }

  if (usePretty) {
    targets.push({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss',
        ignore: 'pid,hostname',
        messageFormat: false,
        customPrettifiers: {},
      },
      level,
    });
  } else {
    // JSON to stdout for production/piping
    targets.push({
      target: 'pino/file',
      options: { destination: 1 }, // fd 1 = stdout
      level,
    });
  }

  const transport = pino.transport({ targets });
  const pinoInstance = pino({ level }, transport);
  return wrapPino(pinoInstance);
}

// ═══════════════════════════════════════════════════════
// Singleton & Convenience
// ═══════════════════════════════════════════════════════

let _defaultLogger: Logger | null = null;

/** Get or create the default singleton logger. */
export function getLogger(): Logger {
  if (!_defaultLogger) {
    _defaultLogger = createLogger();
  }
  return _defaultLogger;
}

/** Initialize the singleton logger with specific options. Call once at startup. */
export function initLogger(opts: LoggerOptions): Logger {
  _defaultLogger = createLogger(opts);
  return _defaultLogger;
}

/** Reset singleton (for tests). */
export function resetLogger(): void {
  _defaultLogger = null;
}

// ═══════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════

/** Truncate a string for logging (avoids massive payloads). */
export function truncate(s: string, maxLen = 500): string {
  return s.length > maxLen ? s.slice(0, maxLen) + `...[${s.length} total]` : s;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/logger.test.ts`
Expected: All 8 tests PASS

**Step 5: Commit**

```bash
git add src/logger.ts tests/logger.test.ts
git commit -m "feat(logger): rewrite with pino backend, child loggers, log levels"
```

---

### Task 3: Create error diagnosis module

**Files:**
- Create: `src/errors.ts`
- Create: `tests/errors.test.ts`

**Step 1: Write failing tests**

```typescript
// tests/errors.test.ts
import { describe, it, expect } from 'vitest';
import { diagnoseError } from '../src/errors.js';

describe('diagnoseError', () => {
  it('should diagnose ETIMEDOUT', () => {
    const d = diagnoseError(new Error('connect ETIMEDOUT 104.18.0.1:443'));
    expect(d.diagnosis).toContain('timeout');
    expect(d.suggestion).toBeTruthy();
    expect(d.raw).toContain('ETIMEDOUT');
  });

  it('should diagnose ECONNREFUSED', () => {
    const d = diagnoseError(new Error('connect ECONNREFUSED 127.0.0.1:8080'));
    expect(d.diagnosis).toContain('refused');
    expect(d.suggestion).toContain('running');
  });

  it('should diagnose ECONNRESET', () => {
    const d = diagnoseError('read ECONNRESET');
    expect(d.diagnosis).toContain('dropped');
  });

  it('should diagnose ENOTFOUND', () => {
    const d = diagnoseError(new Error('getaddrinfo ENOTFOUND api.anthropic.com'));
    expect(d.diagnosis).toContain('DNS');
  });

  it('should diagnose HTTP 401', () => {
    const d = diagnoseError('401 Unauthorized');
    expect(d.diagnosis).toContain('authentication');
    expect(d.suggestion).toContain('ax configure');
  });

  it('should diagnose HTTP 429', () => {
    const d = diagnoseError('429 Too Many Requests');
    expect(d.diagnosis).toContain('rate');
  });

  it('should diagnose HTTP 502/503', () => {
    const d = diagnoseError('502 Bad Gateway');
    expect(d.diagnosis).toContain('API');
  });

  it('should handle unknown errors gracefully', () => {
    const d = diagnoseError('something completely unknown happened');
    expect(d.raw).toContain('something completely unknown');
    expect(d.logHint).toContain('ax.log');
  });

  it('should accept Error objects', () => {
    const d = diagnoseError(new Error('EPIPE'));
    expect(d.diagnosis).toBeTruthy();
  });

  it('should diagnose socket hangup', () => {
    const d = diagnoseError('socket hang up');
    expect(d.diagnosis).toContain('closed');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/errors.test.ts`
Expected: FAIL — module doesn't exist

**Step 3: Implement `src/errors.ts`**

```typescript
// src/errors.ts — Error diagnosis for user-facing error messages
//
// Maps known error patterns to human-readable diagnosis + suggestion.
// Used at every user-facing error boundary (CLI, server HTTP response).

import { join } from 'node:path';
import { homedir } from 'node:os';

export interface DiagnosedError {
  /** Raw error message */
  raw: string;
  /** Human-readable diagnosis */
  diagnosis: string;
  /** Actionable suggestion */
  suggestion: string;
  /** Path hint to full logs */
  logHint: string;
}

interface ErrorPattern {
  test: RegExp;
  diagnosis: string;
  suggestion: string;
}

const PATTERNS: ErrorPattern[] = [
  {
    test: /ETIMEDOUT/i,
    diagnosis: 'Network timeout — could not reach the API',
    suggestion: 'Check your wifi/VPN connection and try again',
  },
  {
    test: /ECONNREFUSED/i,
    diagnosis: 'Connection refused — nothing is listening at the target address',
    suggestion: 'Is the server running? Start it with: ax serve',
  },
  {
    test: /ECONNRESET/i,
    diagnosis: 'Connection dropped mid-request',
    suggestion: 'Network instability — try again',
  },
  {
    test: /ENOTFOUND/i,
    diagnosis: 'DNS resolution failed — hostname not found',
    suggestion: 'Check your internet connection',
  },
  {
    test: /EPIPE|socket hang up|socket hangup/i,
    diagnosis: 'Connection closed unexpectedly',
    suggestion: 'Server may have crashed — check logs',
  },
  {
    test: /\b401\b.*unauthorized|authentication.?error/i,
    diagnosis: 'Authentication failed — credentials are missing or expired',
    suggestion: 'Run `ax configure` to refresh credentials',
  },
  {
    test: /\b403\b.*forbidden/i,
    diagnosis: 'Access denied — API key lacks required permissions',
    suggestion: 'Check your API key permissions at console.anthropic.com',
  },
  {
    test: /\b429\b|rate.?limit|too many requests/i,
    diagnosis: 'Rate limited by the API',
    suggestion: 'Wait a moment and try again, or check your usage limits',
  },
  {
    test: /\b50[023]\b|bad gateway|service unavailable|internal server error/i,
    diagnosis: 'Upstream API error — the service may be down',
    suggestion: 'Check status.anthropic.com for outages',
  },
  {
    test: /CERT|SSL|TLS|self.signed|unable to verify/i,
    diagnosis: 'SSL/TLS handshake failed',
    suggestion: 'Check your system clock, proxy, or firewall settings',
  },
];

function getLogHint(): string {
  const home = process.env.AX_HOME || join(homedir(), '.ax');
  return `Details: ${join(home, 'data', 'ax.log')}`;
}

export function diagnoseError(err: Error | string): DiagnosedError {
  const raw = typeof err === 'string' ? err : err.message;
  const logHint = getLogHint();

  for (const pattern of PATTERNS) {
    if (pattern.test.test(raw)) {
      return {
        raw,
        diagnosis: pattern.diagnosis,
        suggestion: pattern.suggestion,
        logHint,
      };
    }
  }

  return {
    raw,
    diagnosis: 'Unexpected error',
    suggestion: 'See log file for details',
    logHint,
  };
}

/**
 * Format a diagnosed error for user-facing display (CLI, HTTP response).
 * Single-line for server logs, multi-line for CLI.
 */
export function formatDiagnosedError(d: DiagnosedError): string {
  return `${d.diagnosis}: ${d.raw}\n${d.suggestion}\n${d.logHint}`;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/errors.test.ts`
Expected: All 10 tests PASS

**Step 5: Commit**

```bash
git add src/errors.ts tests/errors.test.ts
git commit -m "feat(errors): add error diagnosis module with pattern matching"
```

---

### Task 4: Migrate host server to new logger

**Files:**
- Modify: `src/host/server.ts`
- Modify: `tests/host/server.test.ts`

**Step 1: Update server.ts imports and logger usage**

Replace the old logger imports and usage throughout `src/host/server.ts`:

1. Replace imports:
   ```typescript
   // OLD:
   import { createLogger, type Logger } from '../logger.js';
   import { debug, truncate } from '../logger.js';
   // NEW:
   import { type Logger, truncate, getLogger } from '../logger.js';
   ```

2. Replace logger initialization in `createServer()`:
   ```typescript
   // OLD:
   const logFormat = process.env.LOG_FORMAT === 'json' ? 'json' as const : 'pretty' as const;
   const logger = createLogger({ format: logFormat });
   // NEW:
   const logger = getLogger();
   ```

3. Replace all `debug(SRC, 'event', details)` calls with `logger.debug('event', details)` — remove the `SRC` source param since the logger uses child loggers for context now.

4. In `processCompletion()`, create a child logger:
   ```typescript
   const reqLogger = logger.child({ reqId: requestId.slice(-8) });
   ```
   Then use `reqLogger` instead of `logger` or `debug()` for all logs within that function.

5. Replace `extractFailureReason(stderr)` usage with `diagnoseError()` import from `../errors.js` for the user-facing message. Keep the raw stderr in the log.

6. Fix the `logger.debug()` bug at line ~607 — it now works because our new Logger interface has `debug()`.

7. Replace all `logger.llm_call()`, `logger.scan_inbound()`, `logger.agent_spawn()`, `logger.agent_complete()` calls with standard level methods:
   ```typescript
   // OLD: logger.scan_inbound('clean');
   // NEW: reqLogger.info('scan_inbound', { status: 'clean' });

   // OLD: logger.agent_spawn(requestId, 'subprocess');
   // NEW: reqLogger.info('agent_spawn', { sandbox: 'subprocess' });

   // OLD: logger.agent_complete(requestId, 0, exitCode);
   // NEW: reqLogger.info('agent_complete', { durationSec: 0, exitCode });

   // OLD: logger.error('Agent failed', { exit_code: exitCode, stderr: ... });
   // NEW: reqLogger.error('agent_failed', { exitCode, stderr: stderr.slice(0, 2000) });
   ```

**Step 2: Update tests**

Update `tests/host/server.test.ts`:
- The `extractFailureReason` tests should remain (the function may still be exported for backward compat, or tests should be moved to `tests/errors.test.ts`).
- If `extractFailureReason` is removed, delete its tests from server.test.ts and ensure `diagnoseError` covers the same cases.

**Step 3: Run tests**

Run: `npx vitest run tests/host/server.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server.ts tests/host/server.test.ts src/errors.ts
git commit -m "refactor(server): migrate to unified logger with request tracing"
```

---

### Task 5: Migrate proxy to new logger

**Files:**
- Modify: `src/host/proxy.ts`

**Step 1: Update proxy.ts**

1. Replace import:
   ```typescript
   // OLD:
   import { debug } from '../logger.js';
   // NEW:
   import { getLogger, truncate } from '../logger.js';
   ```

2. Create module-level child logger:
   ```typescript
   const logger = getLogger().child({ component: 'proxy' });
   ```

3. Replace all `debug(SRC, 'event', details)` calls:
   ```typescript
   // OLD: debug(SRC, 'no_credentials', { url: req.url });
   // NEW: logger.warn('no_credentials', { url: req.url });

   // OLD: debug(SRC, 'upstream_error', { status: response.status, ... });
   // NEW: logger.warn('upstream_error', { status: response.status, url: req.url, authMethod });
   ```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: No regressions

**Step 3: Commit**

```bash
git add src/host/proxy.ts
git commit -m "refactor(proxy): migrate to unified logger"
```

---

### Task 6: Migrate IPC server to new logger

**Files:**
- Modify: `src/host/ipc-server.ts`

**Step 1: Update ipc-server.ts**

1. Replace import:
   ```typescript
   // OLD:
   import { debug, truncate } from '../logger.js';
   // NEW:
   import { getLogger, truncate } from '../logger.js';
   ```

2. Create module-level child logger:
   ```typescript
   const logger = getLogger().child({ component: 'ipc' });
   ```

3. Replace all `debug(SRC, ...)` calls with `logger.debug(...)`.

**Step 2: Run tests**

Run: `npx vitest run tests/host/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/ipc-server.ts
git commit -m "refactor(ipc-server): migrate to unified logger"
```

---

### Task 7: Migrate agent-side code to new logger

**Files:**
- Modify: `src/agent/runner.ts`
- Modify: `src/agent/ipc-client.ts`
- Modify: `src/agent/ipc-transport.ts`
- Modify: `src/agent/runners/claude-code.ts`
- Modify: `src/agent/runners/pi-session.ts`
- Modify: `src/agent/stream-utils.ts` (if it uses debug)

**Step 1: Update all agent files**

Same pattern as host migration:
1. Replace `import { debug, truncate } from '../logger.js'` with `import { getLogger, truncate } from '../logger.js'`
2. Create component-scoped child logger: `const logger = getLogger().child({ component: 'runner' })`
3. Replace all `debug(SRC, 'event', details)` with `logger.debug('event', details)`
4. Replace `console.error(...)` in claude-code.ts and runner.ts with `logger.error(...)` + keep `process.stderr.write()` for agent stderr output that the host server collects.

**Important:** Agent processes run in sandboxed subprocesses. The file transport will write to the same `ax.log` since it's the same filesystem. The console transport goes to the agent's stderr which the host collects.

**Step 2: Run tests**

Run: `npx vitest run tests/agent/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/
git commit -m "refactor(agent): migrate all agent code to unified logger"
```

---

### Task 8: Migrate CLI to new logger + error diagnosis

**Files:**
- Modify: `src/cli/index.ts`
- Modify: `src/cli/send.ts`
- Modify: `src/cli/components/App.tsx`
- Modify: `src/main.ts`
- Modify: `src/dotenv.ts`

**Step 1: Update CLI entry points**

`src/cli/index.ts`:
- Replace `console.log('[server] ...')` lines with `getLogger().info(...)`.
- Replace `console.error('Fatal error:', err)` with logger + `diagnoseError()`.

`src/main.ts`:
- Same fatal error handler update.

`src/cli/send.ts`:
- In the catch block, use `diagnoseError()` to show a helpful message:
  ```typescript
  import { diagnoseError, formatDiagnosedError } from '../errors.js';
  // ...
  } catch (err) {
    const diagnosed = diagnoseError(err as Error);
    console.error(formatDiagnosedError(diagnosed));
    process.exit(1);
  }
  ```

`src/cli/components/App.tsx`:
- In the catch block (line ~146), use `diagnoseError()`:
  ```typescript
  } catch (err) {
    const { diagnoseError } = await import('../../errors.js');
    const diagnosed = diagnoseError(err as Error);
    addMessage({
      role: 'system',
      content: `${diagnosed.diagnosis}: ${diagnosed.raw}\n${diagnosed.suggestion}`,
      type: 'error',
    });
    setConnectionStatus('disconnected');
  }
  ```

`src/dotenv.ts`:
- Replace `console.error(...)` with `getLogger().warn(...)`.

**Step 2: Run tests**

Run: `npx vitest run tests/cli/ tests/dotenv.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add src/cli/ src/main.ts src/dotenv.ts
git commit -m "refactor(cli): migrate to unified logger with error diagnosis"
```

---

### Task 9: Migrate provider code to new logger

**Files:**
- Modify: `src/providers/sandbox/subprocess.ts`
- Modify: `src/providers/sandbox/docker.ts`
- Modify: `src/providers/credentials/encrypted.ts`
- Modify: `src/providers/credentials/keychain.ts`
- Modify: `src/providers/llm/anthropic.ts`

**Step 1: Update all provider files**

Replace `console.warn(...)` and `console.error(...)` with `getLogger().warn(...)` and `getLogger().error(...)`.

Example for `subprocess.ts`:
```typescript
// OLD: console.warn('[sandbox-subprocess] WARNING: No isolation — dev-only fallback');
// NEW: getLogger().warn('no_isolation', { message: 'dev-only fallback — no sandbox isolation' });
```

**Step 2: Run tests**

Run: `npx vitest run tests/providers/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/
git commit -m "refactor(providers): migrate to unified logger"
```

---

### Task 10: Add silent catch logging

**Files:**
- Modify: `src/host/server.ts` (cleanup catch blocks)
- Modify: `src/providers/channel/slack.ts` (reconnection logging)

**Step 1: Audit and fix silent catch blocks**

Search for bare `catch {}` and `catch { /* ... */ }` blocks. For each:
- If it's a genuine "ignore this error" case (like cleanup), add `logger.debug('cleanup_failed', { error: ... })`.
- If it's hiding a real error (like the Slack reconnection loop), upgrade to `logger.warn(...)`.

Priority targets:
- `server.ts`: workspace cleanup, socket cleanup, skills dir copy
- `slack.ts`: `ensureConnected()` loop — currently completely silent. Add `logger.warn('slack_reconnect_failed', { error, backoffMs })`.

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS (no behavioral changes, just added logging)

**Step 3: Commit**

```bash
git add src/host/server.ts src/providers/channel/slack.ts
git commit -m "fix: add logging to previously silent catch blocks"
```

---

### Task 11: Initialize logger at startup

**Files:**
- Modify: `src/cli/index.ts`

**Step 1: Add logger initialization in runServe()**

The logger singleton needs to be initialized with the right options before any logging happens:

```typescript
import { initLogger } from '../logger.js';

async function runServe(args: string[]): Promise<void> {
  // ... parse args (--verbose, etc.) ...

  // Initialize logger before anything else
  initLogger({
    level: verbose ? 'debug' : (process.env.LOG_LEVEL as LogLevel) ?? 'info',
    pretty: true,
    file: true,
  });

  // ... rest of startup ...
}
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass, no regressions

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat: initialize logger at startup with --verbose support"
```

---

### Task 12: Remove old logger code

**Files:**
- Modify: `src/logger.ts` (clean up any remaining dead code)
- Modify: `src/host/server.ts` (remove `extractFailureReason` if fully replaced)

**Step 1: Remove dead code**

- Remove the old `LogEvent` interface, old `createLogger` signature, old `debug()` function, and old `formatPretty()`/`colorizeStatus()`/`formatDetails()` helpers if they still exist.
- Remove `extractFailureReason()` from server.ts if all callers now use `diagnoseError()`.
- Update any test imports that reference removed exports.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/logger.ts src/host/server.ts tests/
git commit -m "chore: remove old logger code and extractFailureReason"
```

---

### Task 13: Final integration verification

**Step 1: Build**

Run: `npm run build`
Expected: Clean compilation (ignoring pre-existing TS errors in unrelated files)

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Manual smoke test**

Run: `npm start -- --verbose`
Expected: Color-coded compact structured log output on the console, request IDs in brackets, level labels colored by severity.

**Step 4: Check file log**

Run: `tail -20 ~/.ax/data/ax.log`
Expected: JSONL entries with `level`, `time`, `pid`, `msg`, and any bound context fields.

**Step 5: Final commit (journal + lessons)**

Update `.claude/journal.md` and `.claude/lessons.md`, then:

```bash
git add .claude/
git commit -m "docs: update journal and lessons for logging overhaul"
```
