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
    child(bindings) { return wrapPino(p.child(bindings)); },
  };
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? (process.env.LOG_LEVEL as LogLevel) ?? 'info';
  const usePretty = opts.pretty ?? process.stdout.isTTY ?? false;
  const useFile = opts.file ?? !opts.stream; // disable file when test stream is provided
  // LOG_SYNC=1 forces synchronous file writes so `tail -f` shows entries
  // immediately. Without this, pino buffers ~4KB before flushing.
  const syncFile = process.env.LOG_SYNC === '1';

  // In k8s sandbox mode (NATS or HTTP transport), write console logs to stderr (fd 2)
  // so they don't pollute stdout. Logs stay visible via `kubectl logs` stderr stream.
  const ipcTransport = process.env.AX_IPC_TRANSPORT;
  const consoleFd = (ipcTransport === 'nats' || ipcTransport === 'http') ? 2 : 1;

  // If a test stream is provided, use it directly (no transports)
  if (opts.stream) {
    const pinoInstance = pino({ level }, opts.stream);
    return wrapPino(pinoInstance);
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
      level,
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
    const pinoInstance = pino({ level: 'debug' }, pino.multistream(streams));
    return wrapPino(pinoInstance);
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
      level,
      stream: pino.destination({ dest: consoleFd, sync: true }),
    });
    const pinoInstance = pino({ level: 'debug' }, pino.multistream(streams));
    return wrapPino(pinoInstance);
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

  // JSON to console for production/piping/--json (stderr in NATS mode)
  targets.push({
    target: 'pino/file',
    options: { destination: consoleFd },
    level,
  });

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
