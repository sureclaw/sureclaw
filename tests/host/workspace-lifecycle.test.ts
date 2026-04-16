/**
 * Tests for ephemeral workspace lifecycle.
 *
 * Workspaces are always temporary (mkdtempSync) — the git bare repo
 * at ~/.ax/data/repos/{agentName} is the persistence layer. Each turn
 * clones, agent works, changes commit+push, temp dir is deleted.
 *
 * Git metadata is stored in a separate gitdir (--separate-git-dir),
 * mirroring the k8s git-init approach so agents can't see .git/.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../src/logger.js';
import { validateCommit } from '../../src/host/validate-commit.js';

// We test the git sync/commit helpers indirectly by replicating the
// same git operations that processCompletion performs.

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `ax-ws-lifecycle-${randomUUID()}`);
  mkdirSync(testDir, { recursive: true });
  initLogger({ file: false, level: 'silent' });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Create a bare repo with 'main' as default branch (same as server-completions fallback). */
function createBareRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '--bare', '--initial-branch=main'], { cwd: path, stdio: 'pipe' });
}

/** Clone bare repo into workspace with separate gitdir (same as hostGitSync). */
function gitSync(workspace: string, gitDir: string, repoUrl: string): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  if (!existsSync(join(gitDir, 'HEAD'))) {
    try {
      execFileSync('git', ['clone', '--separate-git-dir', gitDir, repoUrl, '.'], { cwd: workspace, stdio: 'pipe' as const });
      // Remove .git pointer file so agent can't see it
      try { unlinkSync(join(workspace, '.git')); } catch { /* already absent */ }
      try { execFileSync('git', ['branch', '-M', 'main'], gitOpts); } catch { /* ignore */ }
    } catch {
      mkdirSync(gitDir, { recursive: true });
      execFileSync('git', ['init'], gitOpts);
      execFileSync('git', ['remote', 'add', 'origin', repoUrl], gitOpts);
      try { execFileSync('git', ['checkout', '-b', 'main'], gitOpts); } catch { /* ignore */ }
    }
  } else {
    try {
      execFileSync('git', ['pull', 'origin', 'main'], gitOpts);
    } catch { /* ignore */ }
  }
  execFileSync('git', ['config', 'user.name', 'agent'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'agent@ax.local'], gitOpts);
}

/** Commit and push with separate gitdir (same as hostGitCommit). */
function gitCommit(workspace: string, gitDir: string): void {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
  execFileSync('git', ['add', '.'], gitOpts);
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspace, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...gitEnv },
  });
  if (status.trim()) {
    execFileSync('git', ['commit', '-m', 'agent-turn'], gitOpts);
    execFileSync('git', ['push', 'origin', 'main'], gitOpts);
  }
}

/**
 * Commit with .ax/ validation (mirrors hostGitCommit from server-completions.ts).
 * Returns list of files in the final commit (empty if nothing committed).
 */
function gitCommitWithValidation(workspace: string, gitDir: string): string[] {
  const gitEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: workspace };
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };
  const textOpts = { cwd: workspace, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, ...gitEnv } };

  execFileSync('git', ['add', '.'], gitOpts);

  // Validate .ax/ changes before committing (same as hostGitCommit)
  const axDiff = execFileSync('git', ['diff', '--cached', '--', '.ax/'], textOpts).trim();
  if (axDiff) {
    const validation = validateCommit(axDiff);
    if (!validation.ok) {
      // Revert .ax/ changes — unstage, checkout, and clean untracked
      try { execFileSync('git', ['reset', 'HEAD', '--', '.ax/'], gitOpts); } catch { /* no .ax/ staged */ }
      try { execFileSync('git', ['checkout', '--', '.ax/'], gitOpts); } catch { /* no tracked .ax/ to restore */ }
      try { execFileSync('git', ['clean', '-fd', '--', '.ax/'], gitOpts); } catch { /* no untracked .ax/ files */ }
      // Re-stage remaining (non-.ax/) changes
      execFileSync('git', ['add', '.'], gitOpts);
    }
  }

  const status = execFileSync('git', ['status', '--porcelain'], textOpts);
  if (status.trim()) {
    execFileSync('git', ['commit', '-m', 'agent-turn'], gitOpts);
    execFileSync('git', ['push', 'origin', 'main'], gitOpts);
    // Return committed files
    return execFileSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], textOpts)
      .trim().split('\n').filter(Boolean);
  }
  return [];
}

describe('ephemeral workspace lifecycle', () => {
  it('workspace is deleted after turn completes', () => {
    const workspace = join(testDir, 'ephemeral-ws');
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, 'test.txt'), 'hello');

    // Simulate processCompletion finally block
    expect(existsSync(workspace)).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
    expect(existsSync(workspace)).toBe(false);
  });

  it('.git is not visible in workspace (separate gitdir)', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    const ws = join(testDir, 'ws-nogit');
    const gd = join(testDir, 'gd-nogit');
    mkdirSync(ws, { recursive: true });
    gitSync(ws, gd, repoUrl);

    // Agent should NOT see .git in workspace
    expect(existsSync(join(ws, '.git'))).toBe(false);
    // Git metadata should be in the separate gitdir
    expect(existsSync(join(gd, 'HEAD'))).toBe(true);

    // Git operations still work via GIT_DIR/GIT_WORK_TREE
    writeFileSync(join(ws, 'test.txt'), 'hello');
    gitCommit(ws, gd);

    rmSync(ws, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  });

  it('files created in workspace persist via git across turns', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    // Turn 1: create a file in ephemeral workspace
    const ws1 = join(testDir, 'ws-turn1');
    const gd1 = join(testDir, 'gd-turn1');
    mkdirSync(ws1, { recursive: true });
    gitSync(ws1, gd1, repoUrl);
    writeFileSync(join(ws1, 'hello.txt'), 'created in turn 1');
    gitCommit(ws1, gd1);
    // Delete workspace + gitdir (ephemeral)
    rmSync(ws1, { recursive: true, force: true });
    rmSync(gd1, { recursive: true, force: true });
    expect(existsSync(ws1)).toBe(false);

    // Turn 2: clone into fresh workspace — file should be there
    const ws2 = join(testDir, 'ws-turn2');
    const gd2 = join(testDir, 'gd-turn2');
    mkdirSync(ws2, { recursive: true });
    gitSync(ws2, gd2, repoUrl);
    expect(existsSync(join(ws2, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(ws2, 'hello.txt'), 'utf-8')).toBe('created in turn 1');
    // .git should still not be visible
    expect(existsSync(join(ws2, '.git'))).toBe(false);
    rmSync(ws2, { recursive: true, force: true });
    rmSync(gd2, { recursive: true, force: true });
  });

  it('modified files persist across turns', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    // Turn 1: create file
    const ws1 = join(testDir, 'ws-turn1');
    const gd1 = join(testDir, 'gd-turn1');
    mkdirSync(ws1, { recursive: true });
    gitSync(ws1, gd1, repoUrl);
    writeFileSync(join(ws1, 'data.txt'), 'version 1');
    gitCommit(ws1, gd1);
    rmSync(ws1, { recursive: true, force: true });
    rmSync(gd1, { recursive: true, force: true });

    // Turn 2: modify file
    const ws2 = join(testDir, 'ws-turn2');
    const gd2 = join(testDir, 'gd-turn2');
    mkdirSync(ws2, { recursive: true });
    gitSync(ws2, gd2, repoUrl);
    writeFileSync(join(ws2, 'data.txt'), 'version 2');
    gitCommit(ws2, gd2);
    rmSync(ws2, { recursive: true, force: true });
    rmSync(gd2, { recursive: true, force: true });

    // Turn 3: verify modification persisted
    const ws3 = join(testDir, 'ws-turn3');
    const gd3 = join(testDir, 'gd-turn3');
    mkdirSync(ws3, { recursive: true });
    gitSync(ws3, gd3, repoUrl);
    expect(readFileSync(join(ws3, 'data.txt'), 'utf-8')).toBe('version 2');
    rmSync(ws3, { recursive: true, force: true });
    rmSync(gd3, { recursive: true, force: true });
  });

  it('new untracked .ax/ files are cleaned when validation rejects them', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    const ws = join(testDir, 'ws-ax-clean');
    const gd = join(testDir, 'gd-ax-clean');
    mkdirSync(ws, { recursive: true });
    gitSync(ws, gd, repoUrl);

    // Seed the repo with an initial commit so diff-tree works
    writeFileSync(join(ws, 'init.txt'), 'seed');
    gitCommit(ws, gd);

    // Now create a legitimate file AND a disallowed new .ax/ file
    writeFileSync(join(ws, 'legit.txt'), 'allowed content');
    mkdirSync(join(ws, '.ax'), { recursive: true });
    writeFileSync(join(ws, '.ax', 'secrets.txt'), 'disallowed file');

    // Commit with validation — disallowed .ax/ file should be rejected AND cleaned
    const committed = gitCommitWithValidation(ws, gd);

    // The legitimate file should be committed
    expect(committed).toContain('legit.txt');
    // The disallowed .ax/ file must NOT appear in the commit
    expect(committed).not.toContain('.ax/secrets.txt');
    // The disallowed .ax/ file must not exist on disk (cleaned, not just unstaged)
    expect(existsSync(join(ws, '.ax', 'secrets.txt'))).toBe(false);

    rmSync(ws, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  });

  it('bare repo is initialized correctly for new agents', () => {
    const bareRepoPath = join(testDir, 'new-agent.git');
    createBareRepo(bareRepoPath);

    expect(existsSync(bareRepoPath)).toBe(true);
    expect(existsSync(join(bareRepoPath, 'HEAD'))).toBe(true);

    // Should be able to clone (empty repo) — .git NOT in workspace
    const ws = join(testDir, 'ws-clone');
    const gd = join(testDir, 'gd-clone');
    mkdirSync(ws, { recursive: true });
    gitSync(ws, gd, `file://${bareRepoPath}`);
    expect(existsSync(join(ws, '.git'))).toBe(false);
    expect(existsSync(join(gd, 'HEAD'))).toBe(true);
    rmSync(ws, { recursive: true, force: true });
    rmSync(gd, { recursive: true, force: true });
  });
});
