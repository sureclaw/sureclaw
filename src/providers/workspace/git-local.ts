/**
 * Local git workspace provider.
 *
 * Manages bare repos on disk at ~/.ax/repos/<agentId>.
 * Agents clone and push via file:// URLs — no server needed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceProvider } from './types.js';
import type { Config } from '../../types.js';
import { axHome } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'git-local-workspace' });

export async function create(_config: Config): Promise<WorkspaceProvider> {
  const reposDir = join(axHome(), 'repos');

  return {
    async getRepoUrl(agentId: string): Promise<{ url: string; created: boolean }> {
      // Lossless encoding — prevents aliasing (e.g. user:alice vs user-alice)
      const repoName = encodeURIComponent(agentId);

      // safePath validates the constructed path is within reposDir
      const repoPath = safePath(reposDir, repoName);

      // Lazily create repos directory and bare repo.
      // Atomic mkdir (no recursive) detects new vs existing — avoids race
      // where concurrent callers both see "not exists" before git init.
      mkdirSync(reposDir, { recursive: true });
      let created = false;
      try { mkdirSync(repoPath); created = true; } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      try {
        execFileSync('git', ['init', '--bare', repoPath], {
          stdio: 'pipe',
        });
        // Ensure default branch is 'main' regardless of system git config
        try {
          execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], {
            cwd: repoPath, stdio: 'pipe',
          });
        } catch { /* old git — leave as system default */ }
        logger.debug('repo_initialized', { agentId, repoName, repoPath });
      } catch (err) {
        // git init --bare on an existing repo prints "Reinitialized" and
        // exits 0, so it never reaches here. Any error here is real.
        logger.error('repo_init_failed', {
          agentId,
          error: (err as Error).message,
        });
        throw err;
      }

      return { url: `file://${repoPath}`, created };
    },

    async close(): Promise<void> {
      // No resources to clean up
    },
  };
}
