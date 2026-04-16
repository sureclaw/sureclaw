/**
 * Local execute_script handler — shared by ipc-tools.ts and mcp-server.ts.
 *
 * Writes code to a temp .mjs file, runs it with Node.js, and captures stdout.
 * Always runs in-process (no IPC to host needed).
 */

import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const MAX_STDOUT = 10_000;
const RESULTS_DIR = '/tmp/ax-results';

export interface ExecuteScriptArgs {
  code: string;
  timeoutMs?: number;
}

export interface ExecuteScriptResult {
  stdout?: string;
  error?: string;
  stderr?: string;
}

export function executeScript(args: ExecuteScriptArgs, cwd: string): ExecuteScriptResult {
  const tmpFile = join('/tmp', `ax-script-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  try {
    writeFileSync(tmpFile, args.code);
    const timeout = Math.min(args.timeoutMs || 30000, 120000);
    const stdout = execFileSync('node', [tmpFile], {
      cwd,
      timeout,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env },
    }).toString('utf-8');

    if (stdout.length > MAX_STDOUT) {
      // Spill full output to disk so the script can read it back if needed
      const spillId = `script-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const spillPath = join(RESULTS_DIR, `${spillId}.txt`);
      try {
        mkdirSync(RESULTS_DIR, { recursive: true });
        writeFileSync(spillPath, stdout);
      } catch { /* best-effort */ }

      const headSize = Math.floor(MAX_STDOUT * 0.6);
      const tailSize = Math.floor(MAX_STDOUT * 0.4);
      const head = stdout.slice(0, headSize);
      const tail = stdout.slice(-tailSize);
      return {
        stdout:
          `[Output truncated: ${stdout.length} chars total. Full output saved to ${spillPath}]\n\n` +
          head +
          `\n\n... [${stdout.length - MAX_STDOUT} chars truncated] ...\n\n` +
          tail,
      };
    }
    return { stdout };
  } catch (err: any) {
    return { error: err.message, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}
