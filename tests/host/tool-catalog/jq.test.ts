import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { applyJq } from '../../../src/host/tool-catalog/jq.js';

// jq is installed on the shared container image (container/agent/Dockerfile
// line 16) and is a hard production dependency — missing jq in CI must fail
// loudly, not silently skip. The `JQ_TESTS_ALLOW_SKIP=1` knob is for
// contributors on bare dev machines without jq.
const hasJq = (() => {
  try {
    return spawnSync('jq', ['--version']).status === 0;
  } catch {
    return false;
  }
})();

const allowSkip = process.env.JQ_TESTS_ALLOW_SKIP === '1';
if (!hasJq && !allowSkip) {
  throw new Error(
    'jq not found on PATH — set JQ_TESTS_ALLOW_SKIP=1 to skip locally',
  );
}

describe.skipIf(!hasJq)('applyJq', () => {
  test('simple field access returns the single unwrapped value', async () => {
    expect(await applyJq({ a: 1, b: 2 }, '.a')).toBe(1);
  });

  test('identity selector returns the input unchanged', async () => {
    expect(await applyJq({ a: 1 }, '.')).toEqual({ a: 1 });
  });

  test('array pipeline returns single numeric value', async () => {
    expect(await applyJq({ items: [{ id: 1 }, { id: 2 }] }, '.items | length')).toBe(2);
  });

  test('selector producing multiple outputs returns them as an array', async () => {
    expect(
      await applyJq({ items: [{ id: 1 }, { id: 2 }] }, '.items[].id'),
    ).toEqual([1, 2]);
  });

  test('selector producing zero outputs returns null', async () => {
    expect(await applyJq({ items: [] }, '.items[]')).toBeNull();
  });

  test('malformed selector throws with jq stderr first line', async () => {
    // jq 1.7.1 emits "jq: error: syntax error, unexpected end of file ..."
    // for `.[`. Assert on the stable fragment "syntax" — exact wording drifts
    // across jq versions.
    await expect(applyJq({}, '.[')).rejects.toThrow(/syntax/i);
  });

  test('selector that runs past the 500ms timeout throws "jq timed out"', async () => {
    // `def f: f; f` is a left-recursive infinite loop — jq can't short-circuit
    // it, so the spawn timeout is the only thing that stops execution.
    await expect(applyJq({}, 'def f: f; f')).rejects.toThrow(/timed out/i);
  }, 2000);

  test('throws "jq not found on PATH" when jq is not available', async () => {
    // Clear PATH so `spawn('jq')` fails with ENOENT. Scoped restore in finally —
    // vitest shares process env across tests, so leaking this would cascade.
    const origPath = process.env.PATH;
    process.env.PATH = '/nonexistent';
    try {
      await expect(applyJq({}, '.')).rejects.toThrow(/not found on PATH/i);
    } finally {
      process.env.PATH = origPath;
    }
  });

  // REGRESSION (CodeRabbit PR #185): jq's `env` / `$ENV` built-ins expose
  // the spawned process's environment to filter expressions. Since the
  // selector is agent-controlled (LLM output), a malicious/curious selector
  // would otherwise exfiltrate host secrets (API keys, GCS creds, etc.)
  // into the tool response. The spawn now passes a minimal env (PATH +
  // LC_ALL only), so `env` at most returns those two keys.
  test('does not leak host environment variables via jq env builtin', async () => {
    const CANARY = 'leak-test-canary-value-that-must-not-appear';
    const origSecret = process.env.SECRET_JQ_CANARY;
    process.env.SECRET_JQ_CANARY = CANARY;
    try {
      const result = await applyJq({}, 'env');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(CANARY);
      // Sanity: the allowlisted PATH + LC_ALL are visible; that's the shape
      // we chose (need PATH for jq discovery on bizarre installs, LC_ALL
      // for deterministic output).
      expect(serialized).toContain('PATH');
    } finally {
      if (origSecret === undefined) delete process.env.SECRET_JQ_CANARY;
      else process.env.SECRET_JQ_CANARY = origSecret;
    }
  });

  test('does not leak host environment variables via jq $ENV builtin', async () => {
    const CANARY = 'leak-test-canary-2-that-must-not-appear';
    const origSecret = process.env.SECRET_JQ_CANARY_2;
    process.env.SECRET_JQ_CANARY_2 = CANARY;
    try {
      const result = await applyJq({}, '$ENV');
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(CANARY);
    } finally {
      if (origSecret === undefined) delete process.env.SECRET_JQ_CANARY_2;
      else process.env.SECRET_JQ_CANARY_2 = origSecret;
    }
  });

  test('selector starting with a hyphen is treated as a filter, not a flag', async () => {
    // `--` in the spawn argv terminates jq option parsing. Without it, a
    // selector like `-r .` would be interpreted as the `-r` raw-output
    // flag and the bare `.` positional arg. With it, jq gets `-r .` as a
    // single filter string and rejects it as a syntax error (which is
    // the safe outcome — we want the agent to see a parse error, not
    // to accidentally enable an output mode).
    await expect(applyJq({ a: 1 }, '-r .')).rejects.toThrow();
  });
});
