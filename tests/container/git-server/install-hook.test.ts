import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

// Load the container-side CommonJS module from its absolute path.
// The container ships as plain Node (no TS, no bundler), so we require it
// directly rather than importing — keeps parity with how http-server.js
// loads it in the container.
const require = createRequire(import.meta.url);
const containerInstaller = require('../../../container/git-server/install-hook.js');

describe('container/git-server install-hook', () => {
  const dirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'hooks'), { recursive: true });
    dirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  test('writes hook file with agent ID substituted and executable mode', () => {
    const repoDir = makeTmpDir('bare-repo');
    containerInstaller.installPostReceiveHook(repoDir, 'agent-alpha');

    const hookPath = join(repoDir, 'hooks', 'post-receive');
    expect(existsSync(hookPath)).toBe(true);

    const content = readFileSync(hookPath, 'utf8');
    expect(content).toContain('AGENT_ID="agent-alpha"');
    expect(content).not.toContain('__AGENT_ID__');

    const mode = statSync(hookPath).mode & 0o777;
    expect(mode & 0o700).toBe(0o700);
  });

  test('template contains required shell snippets', () => {
    const tpl: string = containerInstaller.TEMPLATE;
    expect(tpl).toContain('set -eu');
    expect(tpl).toContain('openssl dgst');
    expect(tpl).toContain('/v1/internal/skills/reconcile');
    expect(tpl).toContain('X-AX-Hook-Signature');
  });

  test('template uses busybox-compatible od for HMAC hex (not xxd)', () => {
    const tpl: string = containerInstaller.TEMPLATE;
    expect(tpl).toContain("od -An -tx1 | tr -d ' \\n'");
    expect(tpl).not.toContain('xxd');
  });

  test('template skips branch-deletion pushes (all-zero newSha)', () => {
    // Branch deletions send newSha="0000...0000". Reconciling a deleted
    // branch would drop prior skills state (no manifest at that SHA).
    const tpl: string = containerInstaller.TEMPLATE;
    expect(tpl).toContain('0000000000000000000000000000000000000000');
  });

  test('template uses curl --data-binary to preserve exact body bytes', () => {
    const tpl: string = containerInstaller.TEMPLATE;
    expect(tpl).toContain('--data-binary');
    expect(tpl).not.toMatch(/\s-d\s+"\$body"/);
  });

  test('container and host templates produce byte-identical hook content for the same agentId', () => {
    // Read the host TS source directly and extract the TEMPLATE literal.
    // We can't import the TS file at test runtime without the TS compiler
    // stepping in, but we already have a vitest runtime — so importing the
    // compiled-at-test-time source is fine. Use dynamic import on the .ts.
    // However, simpler: we just instantiate both hooks into bare repos and
    // compare the files byte-for-byte.
    const repoA = makeTmpDir('repo-a');
    const repoB = makeTmpDir('repo-b');

    containerInstaller.installPostReceiveHook(repoA, 'agent-xyz');

    // Load the host installer via vitest's TS resolution.
    // Using a relative import from this test file.
    return import('../../../src/providers/workspace/install-hook.js').then(({ installPostReceiveHook: hostInstall }) => {
      hostInstall(repoB, 'agent-xyz');

      const contentA = readFileSync(join(repoA, 'hooks', 'post-receive'), 'utf8');
      const contentB = readFileSync(join(repoB, 'hooks', 'post-receive'), 'utf8');

      expect(contentA).toBe(contentB);
    });
  });

  test('idempotent overwrite replaces agent ID on second call', () => {
    const repoDir = makeTmpDir('bare-repo');
    containerInstaller.installPostReceiveHook(repoDir, 'first');
    containerInstaller.installPostReceiveHook(repoDir, 'second');

    const content = readFileSync(join(repoDir, 'hooks', 'post-receive'), 'utf8');
    expect(content).toContain('AGENT_ID="second"');
    expect(content).not.toContain('first');
    const occurrences = content.match(/AGENT_ID="[^"]*"/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });
});
