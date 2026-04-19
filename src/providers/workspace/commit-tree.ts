/**
 * Shared helper for the `commitFiles` primitive: given a bare repo on disk,
 * apply a set of path writes/deletes on top of `refs/heads/main` using git
 * plumbing (hash-object, update-index, write-tree, commit-tree, update-ref).
 *
 * Idempotent: if the resulting tree sha equals the parent commit's tree sha,
 * no new commit is created and `{ changed: false, commit: <parent> }` is
 * returned. Empty repos (unborn HEAD) with no effective content changes are
 * also a no-op.
 *
 * Concurrency: the final `git update-ref <new> <parent>` is atomic — if the
 * ref moved between our read and write, the call fails and the error
 * surfaces. Callers decide whether to retry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import type { CommitFilesInput, CommitFilesResult } from './types.js';

const DEFAULT_AUTHOR = { name: 'AX Host', email: 'host@ax.local' };

function gitEnv(
  bareRepo: string,
  author: { name: string; email: string },
  indexFile: string,
  workTree: string,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_DIR: bareRepo,
    // `git update-index --remove` refuses to run without a work tree even
    // though we're only touching the index. Point at a throwaway empty dir —
    // blobs come from the object store, so nothing actually reads from here.
    GIT_WORK_TREE: workTree,
    GIT_INDEX_FILE: indexFile,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

async function runGit(
  args: string[],
  env: NodeJS.ProcessEnv,
  input?: Buffer | string,
): Promise<{ stdout: string; stderr: string }> {
  const r = await execFileNoThrow('git', args, { env, input });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return { stdout: r.stdout, stderr: r.stderr };
}

/**
 * Apply `input` to `bareRepo` (a bare git repo on disk) and advance
 * `refs/heads/main`. Returns the new commit sha and whether a commit
 * was actually created.
 */
export async function commitFilesInBareRepo(
  bareRepo: string,
  input: CommitFilesInput,
): Promise<CommitFilesResult> {
  const author = input.author ?? DEFAULT_AUTHOR;
  // Use a throwaway index file so parallel commits against the same bare
  // repo don't stomp on each other. The default `.git/index` would serialise
  // writers badly, and bare repos don't use it anyway.
  const tmpIndexDir = mkdtempSync(join(tmpdir(), 'ax-commit-idx-'));
  const indexFile = join(tmpIndexDir, 'index');
  const env = gitEnv(bareRepo, author, indexFile, tmpIndexDir);

  try {
    // 1. Read current refs/heads/main into the throwaway index (or start empty).
    let parent: string | null = null;
    const revParse = await execFileNoThrow('git', ['rev-parse', '--verify', 'refs/heads/main'], { env });
    if (revParse.status === 0) {
      parent = revParse.stdout.trim();
      await runGit(['read-tree', 'refs/heads/main'], env);
    }
    // If refs/heads/main doesn't exist, index starts empty (no read-tree needed).

    // 2. Apply writes and deletes.
    for (const { path: p, content } of input.files) {
      if (content === null) {
        // Tolerate deletion of a path that isn't in the index — matches
        // the semantics of a plain `rm -f`. `git update-index --remove`
        // without --force errors on missing paths, so gate it.
        const lsFile = await execFileNoThrow(
          'git',
          ['ls-files', '--error-unmatch', p],
          { env },
        );
        if (lsFile.status === 0) {
          await runGit(['update-index', '--remove', p], env);
        }
        continue;
      }
      const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
      const hashed = await runGit(['hash-object', '-w', '--stdin'], env, buf);
      const blobSha = hashed.stdout.trim();
      await runGit(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${p}`], env);
    }

    // 3. Write the tree.
    const treeOut = await runGit(['write-tree'], env);
    const newTree = treeOut.stdout.trim();

    // 4. Idempotency: compare to parent's tree. If identical → no-op.
    if (parent) {
      const parentTreeOut = await runGit(['rev-parse', `${parent}^{tree}`], env);
      if (parentTreeOut.stdout.trim() === newTree) {
        return { commit: parent, changed: false };
      }
    } else {
      // No parent yet. If the new tree is the empty tree, there's nothing
      // to commit — e.g. deletes-only against an empty repo. Return
      // `commit: null` rather than a zero-sha sentinel: there is no ref,
      // and callers that honestly need a sha would otherwise try to resolve
      // all-zeros and fail.
      const emptyTree = await runGit(['hash-object', '-t', 'tree', '--stdin'], env, Buffer.alloc(0));
      if (newTree === emptyTree.stdout.trim()) {
        return { commit: null, changed: false };
      }
    }

    // 5. Commit-tree with optional parent.
    const commitArgs = ['commit-tree', newTree, '-m', input.message];
    if (parent) commitArgs.push('-p', parent);
    const commitOut = await runGit(commitArgs, env);
    const newCommit = commitOut.stdout.trim();

    // 6. Atomic update-ref. Third arg is the expected old value (empty for
    //    unborn HEAD — `git update-ref refs/heads/main <new> ''` asserts
    //    the ref doesn't exist yet).
    const updateArgs = ['update-ref', 'refs/heads/main', newCommit];
    updateArgs.push(parent ?? '');
    await runGit(updateArgs, env);

    return { commit: newCommit, changed: true };
  } finally {
    try { rmSync(tmpIndexDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
