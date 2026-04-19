/**
 * Tests for the `commitFiles` WorkspaceProvider primitive.
 *
 * Focus: git-local path is covered end-to-end against a real bare repo in a
 * tempdir. git-http is covered via a local bare repo acting as `origin`
 * (a full HTTP server fixture is too involved for these unit tests; the
 * git-http code path exercised here is the mirror-and-push logic, which is
 * the interesting novel part — the repo-creation HTTP POST is out of scope).
 */
import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { create as createGitLocal } from '../../../src/providers/workspace/git-local.js';
import { create as createGitHttp } from '../../../src/providers/workspace/git-http.js';
import type { Config } from '../../../src/types.js';

describe('commitFiles — git-local', () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function setAxHome(dir: string): void {
    savedEnv.AX_HOME = process.env.AX_HOME;
    process.env.AX_HOME = dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    if (savedEnv.AX_HOME === undefined) delete process.env.AX_HOME;
    else process.env.AX_HOME = savedEnv.AX_HOME;
    savedEnv.AX_HOME = undefined;
  });

  /** Read a file from refs/heads/main of a bare repo. */
  function catFileAtMain(repoPath: string, relPath: string): string {
    return execFileSync('git', ['-C', repoPath, 'show', `refs/heads/main:${relPath}`], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  function lsTreeAtMain(repoPath: string): string[] {
    const out = execFileSync('git', ['-C', repoPath, 'ls-tree', '-r', '--name-only', 'refs/heads/main'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return out.split('\n').filter(l => l.length > 0);
  }

  test('initial commit into an unborn-HEAD bare repo', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-init';
    const { url } = await provider.getRepoUrl(agentId);
    const repoPath = url.replace(/^file:\/\//, '');

    const result = await provider.commitFiles(agentId, {
      files: [
        { path: 'hello.txt', content: 'hello world' },
        { path: 'sub/dir/nested.md', content: Buffer.from('# Nested') },
      ],
      message: 'initial commit',
      author: { name: 'AX Host', email: 'host@ax.local' },
    });

    expect(result.changed).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    // refs/heads/main points at the returned commit
    const ref = execFileSync('git', ['-C', repoPath, 'rev-parse', 'refs/heads/main'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    expect(ref).toBe(result.commit);

    // Contents match
    expect(catFileAtMain(repoPath, 'hello.txt')).toBe('hello world');
    expect(catFileAtMain(repoPath, 'sub/dir/nested.md')).toBe('# Nested');

    await provider.close();
  });

  test('subsequent commit updates an existing file', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-update';
    const { url } = await provider.getRepoUrl(agentId);
    const repoPath = url.replace(/^file:\/\//, '');

    const first = await provider.commitFiles(agentId, {
      files: [{ path: 'a.txt', content: 'v1' }],
      message: 'first',
    });
    const second = await provider.commitFiles(agentId, {
      files: [{ path: 'a.txt', content: 'v2' }],
      message: 'second',
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.commit).not.toBe(first.commit);
    expect(catFileAtMain(repoPath, 'a.txt')).toBe('v2');

    await provider.close();
  });

  test('identical re-commit is a no-op (changed=false, same sha)', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-noop';
    await provider.getRepoUrl(agentId);

    const input = {
      files: [{ path: 'x.txt', content: 'same' }],
      message: 'same',
    };
    const first = await provider.commitFiles(agentId, input);
    const second = await provider.commitFiles(agentId, input);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.commit).toBe(first.commit);

    await provider.close();
  });

  test('deleting a file (content: null) removes it from the tree', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-delete';
    const { url } = await provider.getRepoUrl(agentId);
    const repoPath = url.replace(/^file:\/\//, '');

    await provider.commitFiles(agentId, {
      files: [
        { path: 'keep.txt', content: 'keep me' },
        { path: 'drop.txt', content: 'drop me' },
      ],
      message: 'seed',
    });
    expect(lsTreeAtMain(repoPath).sort()).toEqual(['drop.txt', 'keep.txt']);

    const result = await provider.commitFiles(agentId, {
      files: [{ path: 'drop.txt', content: null }],
      message: 'drop',
    });
    expect(result.changed).toBe(true);
    expect(lsTreeAtMain(repoPath)).toEqual(['keep.txt']);

    await provider.close();
  });

  test('author info flows through to the commit', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-author';
    const { url } = await provider.getRepoUrl(agentId);
    const repoPath = url.replace(/^file:\/\//, '');

    await provider.commitFiles(agentId, {
      files: [{ path: 'f.txt', content: 'hi' }],
      message: 'authored',
      author: { name: 'Ada Lovelace', email: 'ada@ax.local' },
    });

    const authorLine = execFileSync('git', [
      '-C', repoPath, 'log', '-1', '--format=%an <%ae>', 'refs/heads/main',
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    expect(authorLine).toBe('Ada Lovelace <ada@ax.local>');

    await provider.close();
  });

  test('only delete entries against empty tree is a no-op on unborn HEAD', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const agentId = 'agent-empty-delete';
    const { url } = await provider.getRepoUrl(agentId);
    const repoPath = url.replace(/^file:\/\//, '');

    // Nothing exists yet — deleting a missing path should be a no-op:
    // empty tree in, empty tree out, no commit created.
    const result = await provider.commitFiles(agentId, {
      files: [{ path: 'nonexistent.txt', content: null }],
      message: 'nothing to do',
    });
    expect(result.changed).toBe(false);
    // refs/heads/main should still not exist
    expect(existsSync(join(repoPath, 'refs', 'heads', 'main'))).toBe(false);

    await provider.close();
  });
});

describe('ensureLocalMirror', () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function setAxHome(dir: string): void {
    savedEnv.AX_HOME = process.env.AX_HOME;
    process.env.AX_HOME = dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    if (savedEnv.AX_HOME === undefined) delete process.env.AX_HOME;
    else process.env.AX_HOME = savedEnv.AX_HOME;
    savedEnv.AX_HOME = undefined;
  });

  test('git-local: returns the authoritative bare repo path', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const provider = await createGitLocal({} as Config);
    const path = await provider.ensureLocalMirror('agent-local');
    // Should be a bare repo — `git ls-tree` works, HEAD points at
    // refs/heads/main.
    expect(existsSync(join(path, 'HEAD'))).toBe(true);
    expect(execFileSync('git', ['-C', path, 'symbolic-ref', 'HEAD'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()).toBe('refs/heads/main');
    await provider.close();
  });

  test('git-http: mirror + commit + push works when ensureLocalMirror runs before commitFiles', async () => {
    // Regression: server-init's snapshot-walker path used to maintain its
    // own `git clone --mirror` without the subsequent
    // `git config --unset remote.origin.mirror` that the workspace
    // provider's commit path expected. The two paths shared the same
    // on-disk directory, so whichever ran first left the other broken.
    // Symptom: `workspace.commitFiles` failed with
    // `--mirror can't be combined with refspecs` on push.
    //
    // With `ensureLocalMirror` exposed as the single entry point, both
    // paths now share the same (correctly configured) mirror.
    setAxHome(makeTmpDir('ax-home'));
    const remoteBare = makeTmpDir('remote-bare');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'pipe' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: remoteBare, stdio: 'pipe',
    });

    const provider = await createGitHttp({} as Config);
    provider.getRepoUrl = async () => ({ url: `file://${remoteBare}`, created: false });

    const agentId = 'agent-http-mirror';

    // Simulate snapshot-walker path first — seeds the local mirror.
    const mirrorPath = await provider.ensureLocalMirror(agentId);
    expect(existsSync(join(mirrorPath, 'HEAD'))).toBe(true);

    // Critical: after seeding, `remote.origin.mirror` must NOT be set —
    // otherwise the subsequent push with a refspec fails with
    // "--mirror can't be combined with refspecs". `git config --get`
    // exits 1 when a key is unset, so we expect a throw here.
    expect(() =>
      execFileSync(
        'git', ['-C', mirrorPath, 'config', '--get', 'remote.origin.mirror'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      ),
    ).toThrow();

    // And the fetch refspec should be `+refs/heads/*:refs/heads/*`, not
    // the `+refs/*:refs/*` set by `clone --mirror`.
    const fetchSpec = execFileSync(
      'git', ['-C', mirrorPath, 'config', '--get', 'remote.origin.fetch'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 },
    ).trim();
    expect(fetchSpec).toBe('+refs/heads/*:refs/heads/*');

    await provider.close();
  });

  test('git-http: commitFiles push succeeds after ensureLocalMirror pre-seeded the mirror', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const remoteBare = makeTmpDir('remote-bare');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'pipe' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: remoteBare, stdio: 'pipe',
    });

    const provider = await createGitHttp({} as Config);
    provider.getRepoUrl = async () => ({ url: `file://${remoteBare}`, created: false });

    const agentId = 'agent-http-commit';

    // Pre-seed via the snapshot-walker path.
    await provider.ensureLocalMirror(agentId);

    // Then do a commit + push — this is the flow that previously failed
    // with "--mirror can't be combined with refspecs" because server-init's
    // parallel clone left mirror=true set.
    const result = await provider.commitFiles(agentId, {
      files: [{ path: 'tools/index.js', content: 'export const x = 1;' }],
      message: 'commit after pre-seeded mirror',
      author: { name: 'AX Host', email: 'host@ax.local' },
    });

    expect(result.changed).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    // Remote now has the commit
    const out = execFileSync('git', ['ls-remote', remoteBare, 'refs/heads/main'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    expect(out).toMatch(new RegExp(`^${result.commit}\\s+refs/heads/main$`));

    await provider.close();
  });
});

describe('commitFiles — git-http (via local bare repo as origin)', () => {
  const dirs: string[] = [];
  const savedEnv: Record<string, string | undefined> = {};

  function makeTmpDir(prefix: string): string {
    const dir = join(tmpdir(), `${prefix}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function setAxHome(dir: string): void {
    savedEnv.AX_HOME = process.env.AX_HOME;
    process.env.AX_HOME = dir;
  }

  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    if (savedEnv.AX_HOME === undefined) delete process.env.AX_HOME;
    else process.env.AX_HOME = savedEnv.AX_HOME;
    savedEnv.AX_HOME = undefined;
  });

  /**
   * Spin up a "remote" bare repo in a tempdir, then stub the provider's
   * getRepoUrl to return that file:// URL. The provider's mirror
   * seeding uses `git clone --mirror <url>` and `git push origin ...`,
   * both of which work fine against file:// — so we exercise the real
   * mirror/push flow without needing an HTTP server.
   */
  test('commit pushes to remote bare repo and is visible via ls-remote', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const remoteBare = makeTmpDir('remote-bare');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'pipe' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: remoteBare, stdio: 'pipe',
    });

    const provider = await createGitHttp({} as Config);
    // Override getRepoUrl — the HTTP-API repo-creation step is out of scope for
    // this unit test. The commitFiles code path we want to exercise is the
    // clone-mirror + commit + push pipeline.
    provider.getRepoUrl = async () => ({ url: `file://${remoteBare}`, created: false });

    const agentId = 'agent-http';
    const result = await provider.commitFiles(agentId, {
      files: [{ path: 'index.md', content: '# hello' }],
      message: 'seed',
      author: { name: 'AX Host', email: 'host@ax.local' },
    });

    expect(result.changed).toBe(true);
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);

    // Remote should now have refs/heads/main pointing at the returned commit
    const out = execFileSync('git', ['ls-remote', remoteBare, 'refs/heads/main'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const sha = out.split(/\s+/)[0];
    expect(sha).toBe(result.commit);

    await provider.close();
  });

  test('identical re-commit against same remote is a no-op', async () => {
    setAxHome(makeTmpDir('ax-home'));
    const remoteBare = makeTmpDir('remote-bare');
    execFileSync('git', ['init', '--bare', remoteBare], { stdio: 'pipe' });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: remoteBare, stdio: 'pipe',
    });

    const provider = await createGitHttp({} as Config);
    provider.getRepoUrl = async () => ({ url: `file://${remoteBare}`, created: false });

    const input = {
      files: [{ path: 'a.txt', content: 'same' }],
      message: 'same',
    };
    const first = await provider.commitFiles('agent-http-noop', input);
    const second = await provider.commitFiles('agent-http-noop', input);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.commit).toBe(first.commit);

    await provider.close();
  });
});
