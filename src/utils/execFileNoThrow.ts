/**
 * Safely execute a command without throwing on non-zero exit codes.
 *
 * Returns the exit code, stdout, and stderr, allowing callers to handle
 * failures gracefully instead of propagating exceptions.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export async function execFileNoThrow(
  command: string,
  args: string[],
): Promise<ExecResult> {
  try {
    const result = await execFileAsync(command, args);
    return {
      status: 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  } catch (err: unknown) {
    const e = err as { code?: number | string; status?: number; stdout?: string; stderr?: string; message?: string };
    const status = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : 1;
    return {
      status,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}
