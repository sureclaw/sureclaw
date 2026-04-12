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
  } catch (err: any) {
    return {
      status: err.code || err.status || 1,
      stdout: err.stdout || '',
      stderr: err.stderr || err.message || '',
    };
  }
}
