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
import { Writable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { styleText } from 'node:util';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

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
  /**
   * Subsystem name for per-component log level overrides. When set, the
   * logger checks `LOG_LEVEL_<COMPONENT>` (uppercased, hyphens → underscores)
   * before falling back to `LOG_LEVEL`. Lets an operator crank one noisy
   * subsystem to debug without drowning everything else in stack traces.
   * The component is also added as a binding on every emitted line.
   */
  component?: string;
}

// ═══════════════════════════════════════════════════════
// Per-component level resolution
// ═══════════════════════════════════════════════════════

const LEVEL_NUMERIC: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
  silent: Number.POSITIVE_INFINITY,
};

const KNOWN_LEVELS = new Set(Object.keys(LEVEL_NUMERIC));

function isValidLevel(v: string | undefined): v is LogLevel {
  return !!v && KNOWN_LEVELS.has(v);
}

/**
 * Resolve a log level for a given component name from env vars.
 *
 * Convention: `sandbox-k8s` → `LOG_LEVEL_SANDBOX_K8S`. Uppercase the name
 * and replace `-` with `_`. Falls back to `LOG_LEVEL`, then 'info'.
 *
 * Returns `undefined` if no env vars are set OR if the env value is not a
 * known level — callers can then default. Invalid values are ignored so a
 * typo (`LOG_LEVEL_SANDBOX_K8S=infod`) doesn't crash logger construction.
 */
export function resolveLevelForComponent(component?: string): LogLevel | undefined {
  if (component) {
    const envKey = 'LOG_LEVEL_' + component.toUpperCase().replace(/-/g, '_');
    const v = process.env[envKey];
    if (isValidLevel(v)) return v;
  }
  const fallback = process.env.LOG_LEVEL;
  if (isValidLevel(fallback)) return fallback;
  return undefined;
}

/**
 * The most-permissive level configured anywhere in the environment.
 *
 * Multistream/transport setups give each stream/target its own per-stream
 * level filter. If LOG_LEVEL=info but LOG_LEVEL_SANDBOX_K8S=debug, the
 * console stream filtered at 'info' would silently drop the sandbox-k8s
 * debug lines that the child logger agreed to emit. Setting the per-stream
 * filter to the minimum across all configured levels lets the child-level
 * filter (which knows about the component) be the actual gate.
 *
 * Returns 'info' when nothing is configured, matching the prior default.
 */
function getMinConfiguredLevel(): LogLevel {
  const candidates: LogLevel[] = [];
  const def = process.env.LOG_LEVEL;
  if (isValidLevel(def)) candidates.push(def);
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('LOG_LEVEL_') && isValidLevel(val)) {
      candidates.push(val);
    }
  }
  if (candidates.length === 0) return 'info';
  return candidates.reduce((min, c) =>
    LEVEL_NUMERIC[c] < LEVEL_NUMERIC[min] ? c : min,
  );
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

  const details = formatDetails(obj);
  const detailStr = details ? '  ' + styleText('gray', details) : '';

  return `${styleText('gray', time)}  ${styleText('bold', colorize(msg))}${detailStr}\n`;
}

// ═══════════════════════════════════════════════════════
// Logger Factory
// ═══════════════════════════════════════════════════════

function getLogPath(): string | null {
  const home = process.env.AX_HOME || join(homedir(), '.ax');
  const dir = join(home, 'data');
  try { mkdirSync(dir, { recursive: true }); } catch { return null; /* read-only filesystem */ }
  return join(dir, 'ax.log');
}

function wrapPino(p: PinoLogger): Logger {
  return {
    debug(msg, details) { details ? p.debug(details, msg) : p.debug(msg); },
    info(msg, details) { details ? p.info(details, msg) : p.info(msg); },
    warn(msg, details) { details ? p.warn(details, msg) : p.warn(msg); },
    error(msg, details) { details ? p.error(details, msg) : p.error(msg); },
    fatal(msg, details) { details ? p.fatal(details, msg) : p.fatal(msg); },
    child(bindings) {
      const child = p.child(bindings);
      // If the child carries a `component` binding, honor the
      // LOG_LEVEL_<COMPONENT> env override (e.g. LOG_LEVEL_SANDBOX_K8S=debug
      // bumps verbosity for that subsystem; LOG_LEVEL_SANDBOX_K8S=error
      // silences everything but errors). Falls through to LOG_LEVEL when
      // the per-component var is unset. The override is read at child
      // creation time, so set these env vars BEFORE process start.
      const component = typeof bindings.component === 'string' ? bindings.component : undefined;
      const envLevel = component ? resolveLevelForComponent(component) : undefined;
      if (envLevel && envLevel !== p.level) {
        try { child.level = envLevel; } catch { /* pino rejects unknown levels — ignore */ }
      }
      return wrapPino(child);
    },
  };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  // Level priority: explicit opts.level → LOG_LEVEL_<COMPONENT> →
  // LOG_LEVEL → 'info'. Explicit caller intent always wins; the env vars are
  // operator escape hatches.
  const level = opts.level ?? resolveLevelForComponent(opts.component) ?? 'info';
  const usePretty = opts.pretty ?? process.stdout.isTTY ?? false;
  const useFile = opts.file ?? !opts.stream; // disable file when test stream is provided
  // LOG_SYNC=1 forces synchronous file writes so `tail -f` shows entries
  // immediately. Without this, pino buffers ~4KB before flushing.
  const syncFile = process.env.LOG_SYNC === '1';

  // Agent processes must log to stderr (fd 2) — the host reads stdout as the
  // response. Detected by AX_HOST_URL (k8s), AX_IPC_SOCKET, or AX_IPC_LISTEN (local sandboxes).
  const isAgent = !!(process.env.AX_HOST_URL || process.env.AX_IPC_SOCKET || process.env.AX_IPC_LISTEN);
  const consoleFd = isAgent ? 2 : 1;

  // Per-stream/per-target FLOOR for the multistream/transport paths below.
  // The root pino keeps `level` (so root.debug() filters at LOG_LEVEL); a
  // component child via wrapPino.child gets `child.level` widened to its env
  // override and emits past the root, then the floor here admits it. The
  // floor is the most-permissive level across `opts.level` AND every
  // configured `LOG_LEVEL_*` — explicit caller intent doesn't beat an env
  // override here, otherwise `initLogger({ level: 'info' })` would re-filter
  // out `LOG_LEVEL_SANDBOX_K8S=debug` lines that the component child agreed
  // to emit. The child's own `level` (set in `wrapPino.child`) is the gate
  // for whether a component emits at all; this floor just lets it through.
  const envFloor = getMinConfiguredLevel();
  const consoleStreamLevel: LogLevel =
    opts.level && LEVEL_NUMERIC[opts.level] < LEVEL_NUMERIC[envFloor]
      ? opts.level
      : envFloor;

  // Bypass `wrapPino.child`'s env override — `level` was already resolved above.
  const bindComponent = (logger: Logger, pinoLogger: PinoLogger): Logger =>
    opts.component
      ? wrapPino(pinoLogger.child({ component: opts.component }))
      : logger;

  // If a test stream is provided, use it directly (no transports)
  if (opts.stream) {
    const pinoInstance = pino({ level }, opts.stream);
    return bindComponent(wrapPino(pinoInstance), pinoInstance);
  }

  if (usePretty) {
    // Custom pretty printer using our own prettyFormat() — replaces pino-pretty
    const streams: Array<{ level: string; stream: DestinationStream }> = [];
    const logPath = useFile ? getLogPath() : null;
    if (logPath) {
      streams.push({
        level: 'debug',
        stream: pino.destination({ dest: logPath, mkdir: true, sync: syncFile }),
      });
    }
    const consoleOut = consoleFd === 2 ? process.stderr : process.stdout;
    streams.push({
      level: consoleStreamLevel,
      stream: new Writable({
        write(chunk, _encoding, callback) {
          try {
            consoleOut.write(prettyFormat(JSON.parse(chunk.toString())));
          } catch {
            consoleOut.write(chunk);
          }
          callback();
        },
      }),
    });
    const pinoInstance = pino({ level }, pino.multistream(streams));
    return bindComponent(wrapPino(pinoInstance), pinoInstance);
  }

  // JSON mode: file + stdout via pino transports (worker threads).
  // When LOG_SYNC=1, skip transports and use direct destinations instead
  // so writes are synchronous and immediately visible in `tail -f`.
  if (syncFile) {
    const streams: Array<{ level: string; stream: DestinationStream }> = [];
    const logPath = useFile ? getLogPath() : null;
    if (logPath) {
      streams.push({
        level: 'debug',
        stream: pino.destination({ dest: logPath, mkdir: true, sync: true }),
      });
    }
    streams.push({
      level: consoleStreamLevel,
      stream: pino.destination({ dest: consoleFd, sync: true }),
    });
    const pinoInstance = pino({ level }, pino.multistream(streams));
    return bindComponent(wrapPino(pinoInstance), pinoInstance);
  }

  const targets: pino.TransportTargetOptions[] = [];

  const logPath = useFile ? getLogPath() : null;
  if (logPath) {
    targets.push({
      target: 'pino/file',
      options: { destination: logPath, mkdir: true },
      level: 'debug',
    });
  }

  // JSON to console for production/piping/--json (stderr in k8s HTTP mode)
  targets.push({
    target: 'pino/file',
    options: { destination: consoleFd },
    level: consoleStreamLevel,
  });

  const transport = pino.transport({ targets });
  const pinoInstance = pino({ level }, transport);
  return bindComponent(wrapPino(pinoInstance), pinoInstance);
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
