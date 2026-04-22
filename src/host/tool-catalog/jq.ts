/**
 * Shellout wrapper around the `jq` binary for the tool-catalog `_select`
 * projection. Runs in the HOST process only (agent has no jq available and
 * shouldn't be able to spawn subprocesses anyway).
 *
 * Why shellout instead of node-jq / jq-wasm:
 *   - `jq` is already baked into the shared container image
 *     (`container/agent/Dockerfile`) and present on dev boxes.
 *   - node-jq ships a native binding → extra build step, prebuilds per arch,
 *     harder to debug when it breaks.
 *   - jq-wasm is ~2 MB and noticeably slower.
 *   - One `fork/exec` per `call_tool` is cheap at the rates these fire
 *     (seconds apart, at worst).
 *
 * Contract is narrow on purpose: the only caller is `call_tool`'s response
 * handler, and we want tight, predictable error shapes there.
 */

import { spawn } from 'node:child_process';
import { getLogger } from '../../logger.js';

const log = getLogger().child({ component: 'jq' });

/** Hard cap on jq execution time. Selectors that legitimately need more than
 *  half a second are a smell — this is a projection, not a compute step. */
const JQ_TIMEOUT_MS = 500;

/**
 * Apply a jq `selector` to `data` and return the parsed result.
 *
 * Semantics:
 *   - Zero outputs  → `null`
 *   - One output    → the unwrapped value
 *   - N (>1) outputs → array of the outputs, in jq emit order
 *
 * Throws on: missing jq binary, non-zero exit (bad selector, runtime error),
 * timeout, or unparseable stdout.
 */
export async function applyJq(data: unknown, selector: string): Promise<unknown> {
  const stdin = JSON.stringify(data);

  return new Promise<unknown>((resolve, reject) => {
    // `-c` = compact output, one JSON value per line. Combined with our
    // multi-output collection below this gives us a clean line-delimited
    // stream regardless of whether the selector emits 0/1/N values.
    //
    // `--` terminates jq's option parsing — agent-controlled selectors
    // starting with `-` won't be interpreted as flags.
    //
    // Env scrub: jq exposes host environment variables to filter
    // expressions via `env` / `$ENV`. The `selector` comes from
    // agent-controlled args (LLM output), so without a minimal env a
    // malicious selector like `env` or `$ENV | keys` exfiltrates the
    // host's entire process environment into the tool response. Pass
    // only a PATH (so jq itself can be found on bizarre installations)
    // and a deterministic locale. Everything else — API keys,
    // OPENROUTER_*, GCS creds, etc. — stays invisible.
    const child = spawn('jq', ['-c', '--', selector], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: JQ_TIMEOUT_MS,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LC_ALL: 'C.UTF-8',
      },
    });

    // Collect raw bytes and decode once at `close`. Per-chunk `toString('utf8')`
    // corrupts multi-byte codepoints (CJK, emoji, accented Latin) whose UTF-8
    // bytes straddle a chunk boundary — MCP responses routinely carry those,
    // so this matters as soon as Task 4.3 starts shipping real payloads.
    const stdoutBufs: Buffer[] = [];
    const stderrBufs: Buffer[] = [];
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = `jq` not on PATH. Distinct message so callers (and ops) can
      // tell this apart from a selector error.
      if (err.code === 'ENOENT') {
        settle(() => reject(new Error('jq not found on PATH')));
        return;
      }
      settle(() => reject(err));
    });

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBufs.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBufs.push(chunk);
    });

    child.on('close', (code, signal) => {
      const stdout = Buffer.concat(stdoutBufs).toString('utf8');
      const stderr = Buffer.concat(stderrBufs).toString('utf8');

      // Node sets `signal === 'SIGTERM'` when spawn's `timeout` fires.
      if (signal === 'SIGTERM' && code === null) {
        settle(() => reject(new Error('jq timed out')));
        return;
      }
      if (code !== 0) {
        const firstLine = stderr.split('\n').find((l) => l.trim().length > 0)?.trim()
          ?? `jq exited with code ${code}`;
        settle(() => reject(new Error(firstLine)));
        return;
      }

      // Split on newlines, drop the trailing empty from the final newline,
      // parse each line as JSON. With `-c` every output is on its own line
      // and every line is a complete JSON value.
      const lines = stdout.split('\n').filter((l) => l.length > 0);
      const values: unknown[] = [];
      for (const line of lines) {
        try {
          values.push(JSON.parse(line));
        } catch {
          const preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
          settle(() => reject(new Error(`jq produced non-JSON output: ${preview}`)));
          return;
        }
      }

      if (values.length === 0) settle(() => resolve(null));
      else if (values.length === 1) settle(() => resolve(values[0]));
      else settle(() => resolve(values));
    });

    // Feed the input and close stdin. `end` is safe to call before data
    // events drain — spawn buffers the write.
    child.stdin.on('error', (err) => {
      // EPIPE can happen if jq bails on the selector before reading stdin.
      // Don't let the write crash the process; the `close` handler will
      // surface the real exit-code error.
      log.debug('jq stdin write failed (likely EPIPE)', { err: err.message });
    });
    child.stdin.end(stdin);
  });
}
