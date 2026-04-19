import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resetAgent } from '../../src/cli/bootstrap.js';
import type { WorkspaceProvider } from '../../src/providers/workspace/types.js';

describe('bootstrap command', () => {
  let repoDir: string;
  let workspace: WorkspaceProvider;

  beforeEach(() => {
    const id = randomUUID();
    repoDir = join(tmpdir(), `ax-test-repo-${id}`);
    // Create a bare git repo with identity files
    execFileSync('git', ['init', '--bare', repoDir], { stdio: 'pipe' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repoDir, stdio: 'pipe' });

    // Add identity files via a temp worktree
    const tmpWs = join(tmpdir(), `ax-test-ws-${id}`);
    execFileSync('git', ['clone', repoDir, tmpWs], { stdio: 'pipe' });
    const gitOpts = { cwd: tmpWs, stdio: 'pipe' as const };
    execFileSync('git', ['config', 'user.email', 'test@test.local'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'test'], gitOpts);
    mkdirSync(join(tmpWs, '.ax'), { recursive: true });

    workspace = {
      async getRepoUrl() { return { url: `file://${repoDir}`, created: false }; },
      async ensureLocalMirror() { return repoDir; },
      async commitFiles() { return { commit: null, changed: false }; },
      async close() {},
    };
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  test('resetAgent removes SOUL.md and IDENTITY.md from git repo', async () => {
    // Seed identity files into the repo
    const tmpWs = join(tmpdir(), `ax-test-ws-reset-${randomUUID()}`);
    execFileSync('git', ['clone', repoDir, tmpWs], { stdio: 'pipe' });
    const gitOpts = { cwd: tmpWs, stdio: 'pipe' as const };
    execFileSync('git', ['config', 'user.email', 'test@test.local'], gitOpts);
    execFileSync('git', ['config', 'user.name', 'test'], gitOpts);
    mkdirSync(join(tmpWs, '.ax'), { recursive: true });
    require('fs').writeFileSync(join(tmpWs, '.ax', 'SOUL.md'), '# Old soul');
    require('fs').writeFileSync(join(tmpWs, '.ax', 'IDENTITY.md'), '# Old identity');
    require('fs').writeFileSync(join(tmpWs, '.ax', 'AGENTS.md'), '# Rules');
    execFileSync('git', ['add', '.ax/'], gitOpts);
    execFileSync('git', ['commit', '-m', 'seed'], gitOpts);
    execFileSync('git', ['push', 'origin', 'main'], gitOpts);
    rmSync(tmpWs, { recursive: true, force: true });

    await resetAgent('main', workspace);

    // Verify SOUL.md and IDENTITY.md are gone
    const barOpts = { cwd: repoDir, encoding: 'utf-8' as const, stdio: 'pipe' as const };
    expect(() => execFileSync('git', ['show', 'HEAD:.ax/SOUL.md'], barOpts)).toThrow();
    expect(() => execFileSync('git', ['show', 'HEAD:.ax/IDENTITY.md'], barOpts)).toThrow();
    // AGENTS.md should still exist
    const agents = execFileSync('git', ['show', 'HEAD:.ax/AGENTS.md'], barOpts);
    expect(agents).toContain('# Rules');
  });

  test('resetAgent is idempotent (no error on empty repo)', async () => {
    await expect(resetAgent('main', workspace)).resolves.not.toThrow();
  });
});
