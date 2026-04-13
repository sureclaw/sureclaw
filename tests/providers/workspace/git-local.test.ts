import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

describe('git-local workspace provider', () => {
  const dirs: string[] = [];

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  /** Create a bare repo with default branch set to 'main'. */
  function initBareRepo(): { path: string; url: string } {
    const bareRepo = makeTmpDir('bare-repo');
    execFileSync('git', ['init', '--bare', bareRepo], { stdio: 'pipe' });
    // Set default branch to 'main' (mirrors what git-local provider does)
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: bareRepo, stdio: 'pipe',
    });
    return { path: bareRepo, url: `file://${bareRepo}` };
  }

  /** Clone bare repo into workspace, handling empty repos. */
  function cloneOrInit(workspace: string, repoUrl: string): void {
    const gitOpts = { cwd: workspace, stdio: 'pipe' as const };
    try {
      execFileSync('git', ['clone', repoUrl, '.'], gitOpts);
      try { execFileSync('git', ['branch', '-M', 'main'], gitOpts); } catch { /* no commits yet */ }
    } catch {
      execFileSync('git', ['init'], gitOpts);
      execFileSync('git', ['remote', 'add', 'origin', repoUrl], gitOpts);
      execFileSync('git', ['checkout', '-b', 'main'], gitOpts);
    }
    execFileSync('git', ['config', 'user.name', 'agent'], gitOpts);
    execFileSync('git', ['config', 'user.email', 'agent@ax.local'], gitOpts);
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
  });

  test('clone from bare repo, commit, clone again sees files', () => {
    const { url: repoUrl } = initBareRepo();

    // Session 1: clone into workspace, write a file, commit+push
    const ws1 = makeTmpDir('ws1');
    cloneOrInit(ws1, repoUrl);
    writeFileSync(join(ws1, 'hello.txt'), 'hello world');
    execFileSync('git', ['add', '.'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'test commit'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ws1, stdio: 'pipe' });

    // Session 2: clone into fresh workspace — should see hello.txt
    const ws2 = makeTmpDir('ws2');
    cloneOrInit(ws2, repoUrl);

    expect(existsSync(join(ws2, 'hello.txt'))).toBe(true);
    expect(readFileSync(join(ws2, 'hello.txt'), 'utf-8')).toBe('hello world');
  });

  test('multiple sessions accumulate files', () => {
    const { url: repoUrl } = initBareRepo();

    // Session 1
    const ws1 = makeTmpDir('ws1');
    cloneOrInit(ws1, repoUrl);
    writeFileSync(join(ws1, 'file1.txt'), 'one');
    execFileSync('git', ['add', '.'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'first'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ws1, stdio: 'pipe' });

    // Session 2
    const ws2 = makeTmpDir('ws2');
    cloneOrInit(ws2, repoUrl);
    writeFileSync(join(ws2, 'file2.txt'), 'two');
    execFileSync('git', ['add', '.'], { cwd: ws2, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: ws2, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ws2, stdio: 'pipe' });

    // Session 3: fresh clone should see both files
    const ws3 = makeTmpDir('ws3');
    cloneOrInit(ws3, repoUrl);

    expect(readFileSync(join(ws3, 'file1.txt'), 'utf-8')).toBe('one');
    expect(readFileSync(join(ws3, 'file2.txt'), 'utf-8')).toBe('two');
  });

  test('bare repo has correct file:// URL structure', () => {
    const { path: bareRepo, url } = initBareRepo();
    expect(url).toMatch(/^file:\/\//);
    expect(existsSync(join(bareRepo, 'HEAD'))).toBe(true);
  });

  test('no changes produces no commit', () => {
    const { url: repoUrl } = initBareRepo();

    // Session 1: create initial commit
    const ws1 = makeTmpDir('ws1');
    cloneOrInit(ws1, repoUrl);
    writeFileSync(join(ws1, 'file.txt'), 'content');
    execFileSync('git', ['add', '.'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: ws1, stdio: 'pipe' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: ws1, stdio: 'pipe' });

    // Session 2: clone but make no changes — status should be clean
    const ws2 = makeTmpDir('ws2');
    cloneOrInit(ws2, repoUrl);
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: ws2, encoding: 'utf-8', stdio: 'pipe',
    });
    expect(status.trim()).toBe('');
  });
});
