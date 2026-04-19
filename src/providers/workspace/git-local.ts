/**
 * Local git workspace provider.
 *
 * Manages bare repos on disk at ~/.ax/repos/<agentId>.
 * Agents clone and push via file:// URLs — no server needed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CommitFilesInput, CommitFilesResult, WorkspaceProvider } from './types.js';
import type { Config } from '../../types.js';
import { axHome } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import { installPostReceiveHook } from './install-hook.js';
import { commitFilesInBareRepo } from './commit-tree.js';

const logger = getLogger().child({ component: 'git-local-workspace' });

/**
 * Idempotently bootstrap the bare repo at `repoPath` for `agentId`:
 * mkdir, `git init --bare`, force default branch to `main`, install the
 * post-receive reconcile hook. Safe to call any number of times; all steps
 * are idempotent.
 */
function ensureBareRepo(repoPath: string, agentId: string): void {
  mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', repoPath], { stdio: 'pipe' });
  // Ensure default branch is 'main' regardless of system git config.
  try {
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
      cwd: repoPath, stdio: 'pipe',
    });
  } catch { /* old git — leave as system default */ }
  // The hook embeds the agentId, and installer is an idempotent overwrite —
  // running on every call backfills pre-existing repos.
  installPostReceiveHook(repoPath, agentId);
}

export async function create(_config: Config): Promise<WorkspaceProvider> {
  const reposDir = join(axHome(), 'repos');

  return {
    async getRepoUrl(agentId: string): Promise<{ url: string; created: boolean }> {
      // Lossless encoding — prevents aliasing (e.g. user:alice vs user-alice).
      const repoName = encodeURIComponent(agentId);
      // safePath validates the constructed path is within reposDir.
      const repoPath = safePath(reposDir, repoName);

      mkdirSync(reposDir, { recursive: true });
      // Detect fresh vs. pre-existing before bootstrap so callers know if we
      // just created the repo. `git init --bare` on an existing bare repo is
      // a no-op that prints "Reinitialized", so checking after-the-fact
      // wouldn't distinguish the two.
      const created = !existsSync(repoPath);
      try {
        ensureBareRepo(repoPath, agentId);
        logger.debug('repo_initialized', { agentId, repoName, repoPath });
      } catch (err) {
        logger.error('repo_init_failed', {
          agentId,
          error: (err as Error).message,
        });
        throw err;
      }

      return { url: `file://${repoPath}`, created };
    },

    async ensureLocalMirror(agentId: string): Promise<string> {
      // Local provider: the "mirror" is the authoritative bare repo itself.
      // Bootstrap-on-demand so callers that haven't gone through getRepoUrl
      // first (e.g., loadSnapshot on startup) still get a valid path.
      const repoName = encodeURIComponent(agentId);
      const repoPath = safePath(reposDir, repoName);
      mkdirSync(reposDir, { recursive: true });
      ensureBareRepo(repoPath, agentId);
      return repoPath;
    },

    async commitFiles(agentId: string, input: CommitFilesInput): Promise<CommitFilesResult> {
      const repoName = encodeURIComponent(agentId);
      const repoPath = safePath(reposDir, repoName);
      mkdirSync(reposDir, { recursive: true });
      ensureBareRepo(repoPath, agentId);
      return commitFilesInBareRepo(repoPath, input);
    },

    async close(): Promise<void> {
      // No resources to clean up
    },
  };
}
