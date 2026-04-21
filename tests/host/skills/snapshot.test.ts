import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildSnapshotFromBareRepo } from '../../../src/host/skills/snapshot.js';

/**
 * Runs a sequence of git commands in a sidecar work-tree, mirroring the
 * pattern in container/git-server/http-server.js. The `critical` list names
 * commands that must succeed; other non-zero exits are warnings only.
 */
function runGitCommands(
  cwd: string,
  commands: Array<{ args: string[]; name: string }>,
  critical: string[],
): void {
  for (const cmd of commands) {
    try {
      execFileSync('git', cmd.args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      if (critical.includes(cmd.name)) {
        throw new Error(
          `${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function initBareRepo(bareRepoPath: string): void {
  fs.mkdirSync(bareRepoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepoPath, 'HEAD'), 'ref: refs/heads/main\n');
}

function seedRepo(
  bareRepoPath: string,
  files: Record<string, string>,
): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-snapshot-work-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(workTree, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    runGitCommands(
      workTree,
      [
        { args: ['init', '-b', 'main'], name: 'git init' },
        { args: ['config', 'user.name', 'test'], name: 'git config user.name' },
        { args: ['config', 'user.email', 'test@local'], name: 'git config user.email' },
        { args: ['remote', 'add', 'origin', bareRepoPath], name: 'git remote add' },
        { args: ['add', '-A'], name: 'git add' },
        { args: ['commit', '-m', 'seed'], name: 'git commit' },
        { args: ['push', '-u', 'origin', 'main'], name: 'git push' },
      ],
      ['git init', 'git add', 'git commit', 'git push'],
    );
  } finally {
    try {
      fs.rmSync(workTree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function seedEmptyRepo(bareRepoPath: string): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-snapshot-work-'));
  try {
    runGitCommands(
      workTree,
      [
        { args: ['init', '-b', 'main'], name: 'git init' },
        { args: ['config', 'user.name', 'test'], name: 'git config user.name' },
        { args: ['config', 'user.email', 'test@local'], name: 'git config user.email' },
        { args: ['commit', '--allow-empty', '-m', 'init'], name: 'git commit' },
        { args: ['remote', 'add', 'origin', bareRepoPath], name: 'git remote add' },
        { args: ['push', '-u', 'origin', 'main'], name: 'git push' },
      ],
      ['git init', 'git commit', 'git push'],
    );
  } finally {
    try {
      fs.rmSync(workTree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

describe('buildSnapshotFromBareRepo', () => {
  let bareRepoPath: string;

  beforeEach(() => {
    bareRepoPath = path.join(
      os.tmpdir(),
      `ax-snapshot-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    );
    initBareRepo(bareRepoPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(bareRepoPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('returns sorted entries with ok/error results', async () => {
    const validSkill = `---
name: linear
description: Query Linear issues.
domains:
  - api.linear.app
---

# Linear
Body of the linear skill.
`;
    const invalidSkill = `---
name: broken
# missing description required field
---

body here
`;
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': validSkill,
      '.ax/skills/broken/SKILL.md': invalidSkill,
      'README.md': '# unrelated\n',
    });

    const snapshot = await buildSnapshotFromBareRepo(
      bareRepoPath,
      'refs/heads/main',
    );

    expect(snapshot).toHaveLength(2);
    // Sorted alphabetically: broken < linear
    expect(snapshot.map((e) => e.name)).toEqual(['broken', 'linear']);

    const broken = snapshot[0];
    expect(broken.name).toBe('broken');
    expect(broken.ok).toBe(false);
    if (broken.ok) throw new Error('unreachable');
    expect(typeof broken.error).toBe('string');
    expect(broken.error.length).toBeGreaterThan(0);

    const linear = snapshot[1];
    expect(linear.name).toBe('linear');
    expect(linear.ok).toBe(true);
    if (!linear.ok) throw new Error('unreachable');
    expect(linear.frontmatter.name).toBe('linear');
    expect(linear.frontmatter.description).toBe('Query Linear issues.');
    expect(linear.frontmatter.domains).toEqual(['api.linear.app']);
    expect(linear.body).toContain('# Linear');
  });

  it('returns [] when the repo has no .ax/skills tree', async () => {
    seedRepo(bareRepoPath, {
      'README.md': '# just a readme\n',
    });

    const snapshot = await buildSnapshotFromBareRepo(
      bareRepoPath,
      'refs/heads/main',
    );

    expect(snapshot).toEqual([]);
  });

  it('returns [] for an entirely empty repo (no files at all)', async () => {
    seedEmptyRepo(bareRepoPath);

    const snapshot = await buildSnapshotFromBareRepo(
      bareRepoPath,
      'refs/heads/main',
    );

    expect(snapshot).toEqual([]);
  });

  it('returns [] for a bare repo with no commits yet (no refs/heads/main)', async () => {
    // Regression: before this fix, a brand-new bare repo from `git-local`
    // workspace (init'd but never pushed to) caused `getAgentSkills` to
    // throw on the first turn because `ls-tree refs/heads/main` errors
    // out when the ref doesn't exist. That crashed the whole completion
    // path, surfacing as "Internal processing error" to the user on
    // every first turn. Fix: rev-parse --verify first, return [] on
    // non-existent ref.
    // `bareRepoPath` is set up by beforeEach with `initBareRepo` which
    // only runs `git init --bare` — no commits. So we just pass through.
    const snapshot = await buildSnapshotFromBareRepo(
      bareRepoPath,
      'refs/heads/main',
    );

    expect(snapshot).toEqual([]);
  });

  it('ignores skill directories that have no SKILL.md', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/orphan/README.md': '# not a SKILL.md\n',
      '.ax/skills/orphan/notes.md': 'random notes\n',
    });

    const snapshot = await buildSnapshotFromBareRepo(
      bareRepoPath,
      'refs/heads/main',
    );

    expect(snapshot).toEqual([]);
  });
});
