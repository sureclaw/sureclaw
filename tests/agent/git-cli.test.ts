import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gitExec,
  gitClone,
  gitAdd,
  gitStatus,
  gitCommit,
  gitPush,
  gitFetch,
  gitResetHard,
  gitClean,
  gitConfig,
} from '../../src/agent/git-cli.js';

describe('git-cli', () => {
  let bareRepo: string;
  let workDir: string;

  beforeEach(async () => {
    bareRepo = await mkdtemp(join(tmpdir(), 'git-cli-bare-'));
    workDir = await mkdtemp(join(tmpdir(), 'git-cli-work-'));

    // Create a bare repo with main branch and an initial commit
    await gitExec(['init', '-b', 'main', '--bare', bareRepo]);
    const initDir = await mkdtemp(join(tmpdir(), 'git-cli-init-'));
    await gitExec(['clone', bareRepo, initDir]);
    await gitConfig('user.name', 'test', { cwd: initDir });
    await gitConfig('user.email', 'test@test', { cwd: initDir });
    // Ensure local branch is main (clone may default to master)
    await gitExec(['checkout', '-B', 'main'], { cwd: initDir });
    await writeFile(join(initDir, 'README.md'), 'init');
    await gitAdd({ cwd: initDir });
    await gitExec(['-c', 'user.name=test', '-c', 'user.email=test@test', 'commit', '-m', 'init'], { cwd: initDir });
    await gitExec(['push', '-u', 'origin', 'main'], { cwd: initDir });
    await rm(initDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(bareRepo, { recursive: true });
    await rm(workDir, { recursive: true });
  });

  it('clones a repo', async () => {
    await gitClone(bareRepo, workDir);
    const status = await gitStatus({ cwd: workDir });
    expect(status).toEqual([]);
  });

  it('clones with separate gitdir', async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), 'git-cli-gitdir-'));
    const gitDir = join(tmpBase, 'git'); // must not exist yet for --separate-git-dir
    await gitClone(bareRepo, workDir, { separateGitDir: gitDir });
    // Remove the .git pointer file — sidecar pattern
    await rm(join(workDir, '.git'));
    // Operations work via GIT_DIR + GIT_WORK_TREE env vars
    const status = await gitStatus({ gitDir, workTree: workDir });
    expect(status).toEqual([]);
    await rm(tmpBase, { recursive: true });
  });

  it('stages, commits, and pushes changes', async () => {
    await gitClone(bareRepo, workDir);
    await writeFile(join(workDir, 'file.txt'), 'hello');
    await gitAdd({ cwd: workDir });
    const status = await gitStatus({ cwd: workDir });
    expect(status.length).toBe(1);
    const hash = await gitCommit('add file', { cwd: workDir });
    expect(hash).toMatch(/^[0-9a-f]+$/);
    await gitPush({ cwd: workDir });
  });

  it('fetches and resets with separate gitdir', async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), 'git-cli-gitdir-'));
    const gitDir = join(tmpBase, 'git'); // must not exist yet
    await gitClone(bareRepo, workDir, { separateGitDir: gitDir });
    await rm(join(workDir, '.git'));
    const opts = { gitDir, workTree: workDir };
    await gitFetch(opts);
    await gitResetHard('origin/main', opts);
    const status = await gitStatus(opts);
    expect(status).toEqual([]);
    await rm(tmpBase, { recursive: true });
  });

  it('cleans untracked files', async () => {
    await gitClone(bareRepo, workDir);
    await writeFile(join(workDir, 'untracked.txt'), 'junk');
    await gitClean({ cwd: workDir });
    const out = await gitExec(['status', '--porcelain'], { cwd: workDir });
    expect(out.trim()).toBe('');
  });

  it('throws on invalid repo', async () => {
    await expect(gitClone('/nonexistent/repo', workDir)).rejects.toThrow();
  });
});
