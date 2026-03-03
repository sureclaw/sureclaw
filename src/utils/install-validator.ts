/**
 * Install command validation, environment scrubbing, and concurrency control.
 *
 * Defense-in-depth for skill install commands:
 * - Command prefix allowlisting (§4.2): only known package managers pass
 * - Privilege escalation hard-reject: sudo/su/doas/pkexec blocked unconditionally
 * - Environment scrubbing (§4.3): install commands get minimal env, no credentials
 * - Concurrency semaphore (§4.5): per-agent limit on concurrent installs
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ═══════════════════════════════════════════════════════
// Command prefix allowlisting (§4.2)
// ═══════════════════════════════════════════════════════

const ALLOWED_PREFIXES = /^(npm|npx|brew|pip|pip3|uv|cargo|go|apt|apt-get|apk|gem|composer|dotnet)\b/;
const BLOCKED_PREFIXES = /^(sudo|su|doas|pkexec)\b/;

/**
 * Shell operators and metacharacters that enable command chaining or injection.
 * Since executeInstallStep runs via `/bin/sh -c`, these would allow arbitrary
 * command execution even if the prefix is a valid package manager.
 */
const SHELL_OPERATOR_RE = /[;|&`$><]|\$\(|\)\s*\{/;

export interface CommandValidation {
  valid: boolean;
  reason?: string;
}

export function validateRunCommand(cmd: string): CommandValidation {
  const trimmed = cmd.trim();

  // Hard-reject privilege escalation
  if (BLOCKED_PREFIXES.test(trimmed)) {
    return { valid: false, reason: `Privilege escalation command rejected: ${trimmed.split(/\s/)[0]}` };
  }

  // Reject shell operators that enable command chaining/injection (§11)
  if (SHELL_OPERATOR_RE.test(trimmed)) {
    return { valid: false, reason: 'Shell operators (;, &&, ||, |, `, $(), >, <) are not allowed in install commands' };
  }

  // Require known package manager prefix
  if (!ALLOWED_PREFIXES.test(trimmed)) {
    return { valid: false, reason: 'Command must start with a known package manager (npm, brew, pip, cargo, etc.)' };
  }

  return { valid: true };
}

// ═══════════════════════════════════════════════════════
// Environment variable scrubbing (§4.3)
// ═══════════════════════════════════════════════════════

export function buildScrubbedEnv(): NodeJS.ProcessEnv {
  const { PATH, HOME, USER, TMPDIR, LANG, SHELL } = process.env;
  return {
    PATH,
    HOME,
    USER,
    TMPDIR: TMPDIR ?? '/tmp',
    LANG: LANG ?? 'en_US.UTF-8',
    SHELL: SHELL ?? '/bin/sh',
    // npm/node need this to find the global prefix
    ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}),
    // Homebrew needs this on macOS
    ...(process.env.HOMEBREW_PREFIX ? { HOMEBREW_PREFIX: process.env.HOMEBREW_PREFIX } : {}),
  };
}

// ═══════════════════════════════════════════════════════
// Async command execution (§4.4)
// ═══════════════════════════════════════════════════════

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Execute an install command with scrubbed environment and timeout.
 * Uses async child_process.execFile — never execSync.
 */
export async function executeInstallStep(cmd: string, timeoutMs = 300_000): Promise<ExecResult> {
  const scrubbedEnv = buildScrubbedEnv();
  const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
  const shellArgs = process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd];

  try {
    const { stdout, stderr } = await execFileAsync(
      shell, shellArgs,
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        env: scrubbedEnv,
      }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      exitCode: err.code === 'ETIMEDOUT' ? -1 : (err.status ?? 1),
    };
  }
}

// ═══════════════════════════════════════════════════════
// Concurrency semaphore (§4.5)
// ═══════════════════════════════════════════════════════

/**
 * Per-agent semaphore for concurrent install executions.
 * Prevents resource exhaustion from rapid-fire install requests.
 */
export class InstallSemaphore {
  private readonly maxConcurrent: number;
  private readonly active = new Map<string, number>();  // agentId → count

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(agentId: string): boolean {
    const current = this.active.get(agentId) ?? 0;
    if (current >= this.maxConcurrent) return false;
    this.active.set(agentId, current + 1);
    return true;
  }

  release(agentId: string): void {
    const current = this.active.get(agentId) ?? 0;
    if (current <= 1) this.active.delete(agentId);
    else this.active.set(agentId, current - 1);
  }

  getCount(agentId: string): number {
    return this.active.get(agentId) ?? 0;
  }
}
