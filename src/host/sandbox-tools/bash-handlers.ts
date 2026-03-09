// src/host/sandbox-tools/bash-handlers.ts — Native handlers for Tier 1 bash commands
//
// Phase 2: Each handler implements a single command (or command family) natively
// using the hostcall API (for file access) or pure computation (for stateless ops).
// This eliminates process spawning for the most common read-only commands while
// maintaining the same output contract as the real binaries.
//
// Commands that need real binaries (rg, grep, find, git, etc.) fall through to
// validated execSync with workspace containment and invocation limits.
//
// Output format: handlers produce output identical to what the real command would
// produce when invoked via execSync with stdio: 'pipe' (non-interactive mode).

import { basename, dirname } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import type { ToolInvocationContext } from './wasm-executor.js';

const logger = getLogger().child({ component: 'bash-handlers' });

// ── Interfaces ──

/**
 * Result from a bash command handler.
 * Matches the shape expected by the wasm executor's bash response.
 */
export interface BashHandlerResult {
  output: string;
  exitCode: number;
}

/**
 * Hostcall API subset needed by bash handlers for file access.
 * Keeps handlers decoupled from the full HostcallAPI class.
 */
export interface HostcallsForBash {
  fsRead(path: string): { content: string };
  fsList(path: string, recursive?: boolean, maxEntries?: number): {
    entries: Array<{ name: string; type: string; size: number }>;
  };
}

/**
 * Context passed to every bash handler.
 */
export interface BashHandlerContext {
  workspace: string;
  invocationCtx: ToolInvocationContext;
  hostcalls: HostcallsForBash;
}

/**
 * A native bash command handler function.
 */
export type BashHandler = (args: string[], ctx: BashHandlerContext) => BashHandlerResult;

// ── Handler registry ──

/**
 * Map of command name -> native handler.
 * Commands not in this map fall through to validated execSync.
 */
const NATIVE_HANDLERS: Record<string, BashHandler> = {
  pwd: handlePwd,
  echo: handleEcho,
  basename: handleBasename,
  dirname: handleDirname,
  cat: handleCat,
  head: handleHead,
  tail: handleTail,
  wc: handleWc,
  ls: handleLs,
  stat: handleStat,
  realpath: handleRealpath,
};

/**
 * Look up a native handler for a command. Returns undefined if the command
 * should fall through to validated execSync.
 */
export function getNativeHandler(command: string): BashHandler | undefined {
  return NATIVE_HANDLERS[command];
}

/**
 * Execute a command via validated execSync. Used for commands that need
 * real binaries (rg, grep, find, git, file, tree, du, df) but still benefit
 * from workspace containment, timeout enforcement, and audit logging.
 *
 * nosemgrep: javascript.lang.security.detect-child-process — Tier 1 bash:
 * only invoked for commands the classifier has already verified as read-only
 * (see bash-classifier.ts). The command string comes from the agent via IPC
 * and has been validated by classifyBashCommand() before reaching this path.
 */
export function execValidated(
  command: string,
  ctx: BashHandlerContext,
): BashHandlerResult {
  logger.debug('bash_exec_validated', {
    invocationId: ctx.invocationCtx.invocationId,
    command: command.slice(0, 200),
  });

  try {
    const out = execSync(command, {
      cwd: ctx.workspace,
      encoding: 'utf-8',
      timeout: ctx.invocationCtx.limits.maxTimeMs,
      maxBuffer: ctx.invocationCtx.limits.maxOutputBytes,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { output: out, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
    return { output: `Exit code ${e.status ?? 1}\n${output}`, exitCode: e.status ?? 1 };
  }
}

// ── Pure handlers (no I/O) ──

function handlePwd(_args: string[], ctx: BashHandlerContext): BashHandlerResult {
  // Resolve symlinks to match real pwd output (e.g., macOS /var -> /private/var)
  const resolved = realpathSync(ctx.workspace);
  return { output: resolved + '\n', exitCode: 0 };
}

function handleEcho(args: string[], _ctx: BashHandlerContext): BashHandlerResult {
  let noNewline = false;
  let startIdx = 0;

  if (args[0] === '-n') {
    noNewline = true;
    startIdx = 1;
  }

  const text = args.slice(startIdx).join(' ');
  return { output: noNewline ? text : text + '\n', exitCode: 0 };
}

function handleBasename(args: string[], _ctx: BashHandlerContext): BashHandlerResult {
  const nonFlags = args.filter(a => !a.startsWith('-'));
  if (nonFlags.length === 0) {
    return { output: 'basename: missing operand\n', exitCode: 1 };
  }
  const path = nonFlags[0];
  const suffix = nonFlags[1];
  let result = basename(path);
  if (suffix && result.endsWith(suffix) && result !== suffix) {
    result = result.slice(0, -suffix.length);
  }
  return { output: result + '\n', exitCode: 0 };
}

function handleDirname(args: string[], _ctx: BashHandlerContext): BashHandlerResult {
  const nonFlags = args.filter(a => !a.startsWith('-'));
  if (nonFlags.length === 0) {
    return { output: 'dirname: missing operand\n', exitCode: 1 };
  }
  return { output: dirname(nonFlags[0]) + '\n', exitCode: 0 };
}

// ── FS-based handlers (use hostcall API for validation + quotas) ──

function handleCat(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const showNumbers = args.includes('-n');
  const files = args.filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    return { output: '', exitCode: 0 };
  }

  try {
    const parts: string[] = [];
    for (const file of files) {
      const { content } = ctx.hostcalls.fsRead(file);
      if (showNumbers) {
        const lines = content.split('\n');
        const numbered: string[] = [];
        for (let i = 0; i < lines.length; i++) {
          if (i === lines.length - 1 && lines[i] === '') {
            numbered.push('');
            break;
          }
          numbered.push(`     ${i + 1}\t${lines[i]}`);
        }
        parts.push(numbered.join('\n'));
      } else {
        parts.push(content);
      }
    }
    return { output: parts.join(''), exitCode: 0 };
  } catch (err: unknown) {
    return { output: `cat: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

/**
 * Parse -n flag value from args. Supports: -n 5, -n5, -5, --lines=5.
 */
function parseLineCount(args: string[], defaultCount: number): { count: number; files: string[] } {
  let count = defaultCount;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-n' && i + 1 < args.length) {
      count = parseInt(args[++i], 10) || defaultCount;
    } else if (/^-n\d+$/.test(arg)) {
      count = parseInt(arg.slice(2), 10) || defaultCount;
    } else if (/^-\d+$/.test(arg)) {
      count = parseInt(arg.slice(1), 10) || defaultCount;
    } else if (arg.startsWith('--lines=')) {
      count = parseInt(arg.slice(8), 10) || defaultCount;
    } else if (!arg.startsWith('-')) {
      files.push(arg);
    }
  }

  return { count, files };
}

function handleHead(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const { count, files } = parseLineCount(args, 10);
  if (files.length === 0) {
    return { output: '', exitCode: 0 };
  }

  try {
    const parts: string[] = [];
    const multiFile = files.length > 1;

    for (let fi = 0; fi < files.length; fi++) {
      if (multiFile) {
        if (fi > 0) parts.push('');
        parts.push(`==> ${files[fi]} <==`);
      }
      const { content } = ctx.hostcalls.fsRead(files[fi]);
      const lines = content.split('\n');

      const hasTrailingNewline = content.endsWith('\n');
      const effectiveLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
      const selected = effectiveLines.slice(0, count);

      parts.push(selected.join('\n'));
      if (hasTrailingNewline || selected.length < effectiveLines.length) {
        parts.push('');
      }
    }

    return { output: parts.join('\n'), exitCode: 0 };
  } catch (err: unknown) {
    return { output: `head: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

function handleTail(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const { count, files } = parseLineCount(args, 10);
  if (files.length === 0) {
    return { output: '', exitCode: 0 };
  }

  try {
    const parts: string[] = [];
    const multiFile = files.length > 1;

    for (let fi = 0; fi < files.length; fi++) {
      if (multiFile) {
        if (fi > 0) parts.push('');
        parts.push(`==> ${files[fi]} <==`);
      }
      const { content } = ctx.hostcalls.fsRead(files[fi]);
      const lines = content.split('\n');

      const hasTrailingNewline = content.endsWith('\n');
      const effectiveLines = hasTrailingNewline ? lines.slice(0, -1) : lines;
      const selected = effectiveLines.slice(-count);

      parts.push(selected.join('\n'));
      if (hasTrailingNewline) {
        parts.push('');
      }
    }

    return { output: parts.join('\n'), exitCode: 0 };
  } catch (err: unknown) {
    return { output: `tail: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

function handleWc(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const flagL = args.includes('-l');
  const flagW = args.includes('-w');
  const flagC = args.includes('-c');
  const flagM = args.includes('-m');
  const showBytes = flagC || flagM;
  const showAll = !flagL && !flagW && !showBytes;

  const files = args.filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    return { output: '', exitCode: 0 };
  }

  try {
    const results: string[] = [];
    let totalLines = 0, totalWords = 0, totalBytes = 0;

    for (const file of files) {
      const { content } = ctx.hostcalls.fsRead(file);

      // wc -l counts newline characters
      let lineCount = 0;
      for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') lineCount++;
      }
      const wordCount = content.split(/\s+/).filter(Boolean).length;
      const byteCount = Buffer.byteLength(content, 'utf-8');

      totalLines += lineCount;
      totalWords += wordCount;
      totalBytes += byteCount;

      const cols: string[] = [];
      if (showAll || flagL) cols.push(String(lineCount).padStart(8));
      if (showAll || flagW) cols.push(String(wordCount).padStart(8));
      if (showAll || showBytes) cols.push(String(byteCount).padStart(8));
      cols.push(` ${file}`);
      results.push(cols.join(''));
    }

    if (files.length > 1) {
      const cols: string[] = [];
      if (showAll || flagL) cols.push(String(totalLines).padStart(8));
      if (showAll || flagW) cols.push(String(totalWords).padStart(8));
      if (showAll || showBytes) cols.push(String(totalBytes).padStart(8));
      cols.push(' total');
      results.push(cols.join(''));
    }

    return { output: results.join('\n') + '\n', exitCode: 0 };
  } catch (err: unknown) {
    return { output: `wc: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

function handleLs(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const combinedFlags = args.filter(a => a.startsWith('-')).join('');
  const showAll = combinedFlags.includes('a');
  const longFormat = combinedFlags.includes('l');
  const humanReadable = combinedFlags.includes('h');

  const dirs = args.filter(a => !a.startsWith('-'));
  const targets = dirs.length > 0 ? dirs : ['.'];

  try {
    const allParts: string[] = [];
    const multiTarget = targets.length > 1;

    for (let ti = 0; ti < targets.length; ti++) {
      if (multiTarget) {
        if (ti > 0) allParts.push('');
        allParts.push(`${targets[ti]}:`);
      }

      const { entries } = ctx.hostcalls.fsList(targets[ti]);

      let filtered = entries;
      if (!showAll) {
        filtered = entries.filter(e => !e.name.startsWith('.'));
      }

      filtered.sort((a, b) => a.name.localeCompare(b.name));

      if (longFormat) {
        allParts.push(`total ${filtered.length}`);
        for (const e of filtered) {
          const typeChar = e.type === 'directory' ? 'd' : '-';
          const perms = `${typeChar}rw-r--r--`;
          const size = humanReadable ? humanSize(e.size) : String(e.size);
          allParts.push(`${perms}  ${size.padStart(humanReadable ? 5 : 8)} ${e.name}`);
        }
      } else {
        for (const e of filtered) {
          allParts.push(e.name);
        }
      }
    }

    return { output: allParts.join('\n') + '\n', exitCode: 0 };
  } catch (err: unknown) {
    return { output: `ls: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(0)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

function handleStat(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const files = args.filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    return { output: 'stat: missing operand\n', exitCode: 1 };
  }

  try {
    const parts: string[] = [];
    for (const file of files) {
      const segments = file.split(/[/\\]/).filter(Boolean);
      const abs = file === '.' ? ctx.workspace : safePath(ctx.workspace, ...segments);
      const st = statSync(abs);

      parts.push(`  File: ${file}`);
      parts.push(`  Size: ${st.size}\tBlocks: ${st.blocks}\t${st.isDirectory() ? 'directory' : 'regular file'}`);
      parts.push(`Access: ${st.atime.toISOString()}`);
      parts.push(`Modify: ${st.mtime.toISOString()}`);
      parts.push(`Change: ${st.ctime.toISOString()}`);
    }
    return { output: parts.join('\n') + '\n', exitCode: 0 };
  } catch (err: unknown) {
    return { output: `stat: ${(err as Error).message}\n`, exitCode: 1 };
  }
}

function handleRealpath(args: string[], ctx: BashHandlerContext): BashHandlerResult {
  const files = args.filter(a => !a.startsWith('-'));
  if (files.length === 0) {
    return { output: 'realpath: missing operand\n', exitCode: 1 };
  }

  try {
    const parts: string[] = [];
    for (const file of files) {
      const segments = file.split(/[/\\]/).filter(Boolean);
      const abs = safePath(ctx.workspace, ...segments);
      const resolved = realpathSync(abs);
      parts.push(resolved);
    }
    return { output: parts.join('\n') + '\n', exitCode: 0 };
  } catch (err: unknown) {
    return { output: `realpath: ${(err as Error).message}\n`, exitCode: 1 };
  }
}
