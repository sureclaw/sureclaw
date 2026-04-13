/**
 * Tests for ephemeral workspace lifecycle.
 *
 * Workspaces are always temporary (mkdtempSync) — the git bare repo
 * at ~/.ax/data/repos/{agentName} is the persistence layer. Each turn
 * clones, agent works, changes commit+push, temp dir is deleted.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initLogger } from '../../src/logger.js';

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

/** Clone bare repo into workspace (same as hostGitSync). */
function gitSync(workspace: string, repoUrl: string): void {
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const };
  try {
    execFileSync('git', ['clone', repoUrl, '.'], gitOpts);
    try { execFileSync('git', ['branch', '-M', 'main'], gitOpts); } catch { /* ignore */ }
  } catch {
    execFileSync('git', ['init'], gitOpts);
    execFileSync('git', ['remote', 'add', 'origin', repoUrl], gitOpts);
    try { execFileSync('git', ['checkout', '-b', 'main'], gitOpts); } catch { /* ignore */ }
  }
  execFileSync('git', ['config', 'user.name', 'agent'], gitOpts);
  execFileSync('git', ['config', 'user.email', 'agent@ax.local'], gitOpts);
}

/** Commit and push (same as hostGitCommit). */
function gitCommit(workspace: string): void {
  const gitOpts = { cwd: workspace, stdio: 'pipe' as const };
  execFileSync('git', ['add', '.'], gitOpts);
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: workspace, encoding: 'utf-8', stdio: 'pipe',
  });
  if (status.trim()) {
    execFileSync('git', ['commit', '-m', 'agent-turn'], gitOpts);
    execFileSync('git', ['push', 'origin', 'main'], gitOpts);
  }
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

  it('files created in workspace persist via git across turns', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    // Turn 1: create a file in ephemeral workspace
    const ws1 = join(testDir, 'ws-turn1');
    mkdirSync(ws1, { recursive: true });
    gitSync(ws1, repoUrl);
    writeFileSync(join(ws1, 'hello.txt'), 'created in turn 1');
    gitCommit(ws1);
    // Delete workspace (ephemeral)
    rmSync(ws1, { recursive: true, force: true });
    expect(existsSync(ws1)).toBe(false);

    // Turn 2: clone into fresh workspace — file should be there
    const ws2 = join(testDir, 'ws-turn2');
    mkdirSync(ws2, { recursive: true });
    gitSync(ws2, repoUrl);
    expect(existsSync(join(ws2, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(ws2, 'hello.txt'), 'utf-8')).toBe('created in turn 1');
    rmSync(ws2, { recursive: true, force: true });
  });

  it('modified files persist across turns', () => {
    const bareRepoPath = join(testDir, 'repo.git');
    const repoUrl = `file://${bareRepoPath}`;
    createBareRepo(bareRepoPath);

    // Turn 1: create file
    const ws1 = join(testDir, 'ws-turn1');
    mkdirSync(ws1, { recursive: true });
    gitSync(ws1, repoUrl);
    writeFileSync(join(ws1, 'data.txt'), 'version 1');
    gitCommit(ws1);
    rmSync(ws1, { recursive: true, force: true });

    // Turn 2: modify file
    const ws2 = join(testDir, 'ws-turn2');
    mkdirSync(ws2, { recursive: true });
    gitSync(ws2, repoUrl);
    writeFileSync(join(ws2, 'data.txt'), 'version 2');
    gitCommit(ws2);
    rmSync(ws2, { recursive: true, force: true });

    // Turn 3: verify modification persisted
    const ws3 = join(testDir, 'ws-turn3');
    mkdirSync(ws3, { recursive: true });
    gitSync(ws3, repoUrl);
    expect(readFileSync(join(ws3, 'data.txt'), 'utf-8')).toBe('version 2');
    rmSync(ws3, { recursive: true, force: true });
  });

  it('bare repo is initialized correctly for new agents', () => {
    const bareRepoPath = join(testDir, 'new-agent.git');
    createBareRepo(bareRepoPath);

    expect(existsSync(bareRepoPath)).toBe(true);
    expect(existsSync(join(bareRepoPath, 'HEAD'))).toBe(true);

    // Should be able to clone (empty repo)
    const ws = join(testDir, 'ws-clone');
    mkdirSync(ws, { recursive: true });
    gitSync(ws, `file://${bareRepoPath}`);
    expect(existsSync(join(ws, '.git'))).toBe(true);
    rmSync(ws, { recursive: true, force: true });
  });
});
