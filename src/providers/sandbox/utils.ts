/**
 * Shared sandbox utilities — common patterns across all sandbox providers.
 */

import { execFileSync, type ChildProcess } from 'node:child_process';
import type { SandboxProcess } from './types.js';

/** Create a promise that resolves with the child's exit code. */
export function exitCodePromise(child: ChildProcess): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', reject);
  });
}

/**
 * Kill the child after timeoutSec. Sends SIGTERM first, then SIGKILL after
 * a grace period (default 5s) if the process hasn't exited. This gives
 * the agent a chance to flush output and clean up before being force-killed.
 *
 * No-op if timeoutSec is undefined.
 */
export function enforceTimeout(child: ChildProcess, timeoutSec?: number, graceSec = 5): void {
  if (!timeoutSec) return;

  // Track whether the child has actually exited (child.killed only tracks
  // whether we've *called* kill(), not whether the process is dead).
  let exited = false;
  child.on('exit', () => { exited = true; });

  setTimeout(() => {
    if (exited) return;

    // Try graceful termination first
    child.kill('SIGTERM');

    // If still alive after grace period, force kill
    setTimeout(() => {
      if (!exited) {
        child.kill('SIGKILL');
      }
    }, graceSec * 1000);
  }, timeoutSec * 1000);
}

/** Send SIGKILL to a pid, swallowing errors for already-exited processes. */
export async function killProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Process already exited
  }
}

/** Check if a command is available on the system. */
export async function checkCommand(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Wrap a ChildProcess into a SandboxProcess. */
export function sandboxProcess(child: ChildProcess, exitCode: Promise<number>): SandboxProcess {
  return {
    pid: child.pid!,
    exitCode,
    stdout: child.stdout!,
    stderr: child.stderr!,
    stdin: child.stdin!,
    kill() { child.kill(); },
  };
}
