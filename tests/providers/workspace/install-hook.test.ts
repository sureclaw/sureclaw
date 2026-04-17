import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { installPostReceiveHook } from '../../../src/providers/workspace/install-hook.js';

describe('installPostReceiveHook', () => {
  const dirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function initBareRepo(): string {
    const bareRepo = makeTmpDir('bare-repo');
    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });
    return bareRepo;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  test('fresh install writes hook with agent ID substituted and executable mode', () => {
    const bareRepo = initBareRepo();
    installPostReceiveHook(bareRepo, 'agent-x');

    const hookPath = join(bareRepo, 'hooks', 'post-receive');
    expect(existsSync(hookPath)).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('AGENT_ID="agent-x"');
    // No unsubstituted placeholders should remain.
    expect(content).not.toContain('__AGENT_ID__');

    // Owner-executable bit must be set.
    const mode = statSync(hookPath).mode & 0o777;
    expect(mode & 0o700).toBe(0o700);
  });

  test('idempotent overwrite replaces agent ID on second call', () => {
    const bareRepo = initBareRepo();
    installPostReceiveHook(bareRepo, 'agent-first');
    installPostReceiveHook(bareRepo, 'agent-second');

    const hookPath = join(bareRepo, 'hooks', 'post-receive');
    const content = readFileSync(hookPath, 'utf8');

    expect(content).toContain('AGENT_ID="agent-second"');
    expect(content).not.toContain('agent-first');
    // Only a single AGENT_ID assignment should exist — no accumulation.
    const occurrences = content.match(/AGENT_ID="[^"]*"/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  test('hook body contains the reconcile endpoint path and HMAC header', () => {
    const bareRepo = initBareRepo();
    installPostReceiveHook(bareRepo, 'agent-y');

    const content = readFileSync(join(bareRepo, 'hooks', 'post-receive'), 'utf8');
    expect(content).toContain('/v1/internal/skills/reconcile');
    expect(content).toContain('X-AX-Hook-Signature');
    // set -eu guards against unset vars; pipefail is deliberately omitted (not POSIX).
    expect(content).toContain('set -eu');
  });

  test('hook skips branch-deletion pushes (all-zero newSha)', () => {
    // Branch deletions send newSha="0000...0000". We MUST skip these —
    // there's no commit to read the manifest from, and reconciling would
    // drop prior skills state via skills.reconcile_failed.
    const bareRepo = initBareRepo();
    installPostReceiveHook(bareRepo, 'agent-z');
    const content = readFileSync(join(bareRepo, 'hooks', 'post-receive'), 'utf8');
    expect(content).toContain('0000000000000000000000000000000000000000');
  });

  test('hook uses curl --data-binary (not -d) to preserve exact body bytes', () => {
    // The HMAC covers exact bytes of the JSON body. curl -d strips CR/LF
    // and can mangle input; --data-binary sends the string as-is.
    const bareRepo = initBareRepo();
    installPostReceiveHook(bareRepo, 'agent-d');
    const content = readFileSync(join(bareRepo, 'hooks', 'post-receive'), 'utf8');
    expect(content).toContain('--data-binary');
    // Make sure we didn't keep a stray `-d "$body"` — match with a boundary
    // so `--data-binary` doesn't accidentally satisfy a plain `-d` check.
    expect(content).not.toMatch(/\s-d\s+"\$body"/);
  });
});
