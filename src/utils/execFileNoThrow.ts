/**
 * Safely execute a command without throwing on non-zero exit codes.
 *
 * Returns the exit code, stdout, and stderr, allowing callers to handle
 * failures gracefully instead of propagating exceptions.
 */

import { execFile } from 'node:child_process';

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface ExecOpts {
  /** Data to pipe to the child's stdin. */
  input?: Buffer | string;
  /** Environment variables for the child (pass `{...process.env, FOO: 'bar'}` to extend). */
  env?: NodeJS.ProcessEnv;
  /** Working directory for the child process. */
  cwd?: string;
  /** Max output buffer size in bytes (default 10MB, same as Node's default). */
  maxBuffer?: number;
}

export async function execFileNoThrow(
  command: string,
  args: string[],
  opts: ExecOpts = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      {
        env: opts.env,
        cwd: opts.cwd,
        maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      },
      (err, stdout: string | Buffer, stderr: string | Buffer) => {
        const stdoutStr = typeof stdout === 'string' ? stdout : stdout.toString('utf-8');
        const stderrStr = typeof stderr === 'string' ? stderr : stderr.toString('utf-8');
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string };
          const status = typeof e.code === 'number' ? e.code : 1;
          resolve({ status, stdout: stdoutStr, stderr: stderrStr });
          return;
        }
        resolve({ status: 0, stdout: stdoutStr, stderr: stderrStr });
      },
    );

    if (opts.input !== undefined && child.stdin) {
      // Swallow EPIPE/ECONNRESET from a child that exits before reading all
      // stdin. Without this, Node emits 'error' on the stream and — with no
      // listener — crashes the process. The exit/error path of execFile
      // itself still surfaces via the callback.
      child.stdin.on('error', () => { /* ignore — child's exit reports status */ });
      child.stdin.end(opts.input);
    }
  });
}
