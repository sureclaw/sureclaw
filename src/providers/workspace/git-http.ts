/**
 * HTTP-based Git workspace provider.
 *
 * Uses a shared Git server with smart HTTP protocol for workspace repos.
 * Repos are created via HTTP API endpoint on git-server.
 * Agents clone and push via HTTP — no SSH or credentials needed.
 *
 * Features:
 * - Idempotent repo creation (safe to retry)
 * - Backoff retry on HTTP failures
 * - Safe error handling (repo creation failures don't crash agent)
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommitFilesInput, CommitFilesResult, WorkspaceProvider } from './types.js';
import type { Config } from '../../types.js';
import { axHome } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';
import { execFileNoThrow } from '../../utils/execFileNoThrow.js';
import { commitFilesInBareRepo } from './commit-tree.js';

const logger = getLogger().child({ component: 'git-http-workspace' });

const MAX_REPO_CREATION_RETRIES = 3;
const REPO_CREATION_RETRY_DELAY_MS = 1000;

async function runGit(args: string[], cwd?: string): Promise<void> {
  const r = await execFileNoThrow('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (exit ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

export async function create(config: Config): Promise<WorkspaceProvider> {
  // Construct fully qualified service name: ax-git.namespace.svc.cluster.local
  const serviceName = 'ax-git';
  const namespace = config.namespace || 'default';
  const gitHost = config.gitServer?.host || `${serviceName}.${namespace}.svc.cluster.local`;
  const gitHttpPort = config.gitServer?.httpPort || 8000;

  const reposDir = join(axHome(), 'repos');
  const seededMirrors = new Set<string>();

  /**
   * Ensure a local bare-repo mirror exists for `agentId`, seeded from the
   * remote git-http origin. Mirrors what `server-init.ts::getBareRepoPath`
   * does — kept self-contained here so the provider owns its on-disk state.
   */
  async function ensureMirror(agentId: string, originUrl: string): Promise<string> {
    const localPath = safePath(reposDir, encodeURIComponent(agentId));
    const alreadySeeded = seededMirrors.has(agentId) || existsSync(join(localPath, 'HEAD'));
    if (!alreadySeeded) {
      // Clone + reconfigure must all succeed, or the on-disk mirror is torn
      // down so the next call re-clones cleanly. Any half-configured state
      // (e.g. clone succeeded but unset-mirror failed) would otherwise be
      // mistaken for a valid seed on the next call (HEAD exists →
      // alreadySeeded=true) and every subsequent push would fail with
      // "--mirror can't be combined with refspecs".
      mkdirSync(dirname(localPath), { recursive: true });
      try { rmSync(localPath, { recursive: true, force: true }); } catch { /* best effort */ }
      try {
        await runGit(['clone', '--mirror', originUrl, localPath]);
        // `--mirror` sets `remote.origin.mirror=true`, which forbids pushing a
        // single refspec. We want to own the push ref list explicitly, so drop
        // the mirror flag while keeping the bare layout.
        await runGit(['-C', localPath, 'config', '--unset', 'remote.origin.mirror']);
        await runGit(['-C', localPath, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/heads/*']);
      } catch (err) {
        try { rmSync(localPath, { recursive: true, force: true }); } catch { /* best effort */ }
        throw err;
      }
      seededMirrors.add(agentId);
    } else {
      await runGit(['-C', localPath, 'fetch', '--prune', 'origin']);
    }
    return localPath;
  }

  const provider: WorkspaceProvider = {
    async getRepoUrl(agentId: string): Promise<{ url: string; created: boolean }> {
      // Lossless encoding — prevents aliasing (e.g. user:alice vs user-alice)
      const repoName = encodeURIComponent(agentId);
      let created = false;

      // Retry with backoff on HTTP failures
      for (let attempt = 0; attempt < MAX_REPO_CREATION_RETRIES; attempt++) {
        try {
          logger.debug('creating_repo', {
            agentId,
            repoName,
            attempt: attempt + 1,
          });

          // Create bare repo via HTTP API
          const url = `http://${gitHost}:${gitHttpPort}/repos`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30_000);
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: repoName }),
            signal: controller.signal,
          });
          clearTimeout(timeout);

          if (response.ok || response.status === 409) {
            if (response.ok) {
              const result = await response.json();
              logger.info('repo_created', { agentId, repoName, path: result.path });
              created = true;
            } else {
              // 409 = repo exists. This includes the case where a prior attempt
              // created it but the response timed out. Callers should not rely
              // solely on `created` for seeding — check repo content as fallback.
              logger.debug('repo_exists', { agentId, repoName });
            }
            break;
          }

          // HTTP error — retry on next attempt
          if (attempt < MAX_REPO_CREATION_RETRIES - 1) {
            const text = await response.text();
            logger.warn('repo_creation_failed_will_retry', {
              agentId,
              attempt: attempt + 1,
              status: response.status,
              error: text,
            });
            // Backoff: 1s, 2s, 4s
            await new Promise(resolve =>
              setTimeout(resolve, REPO_CREATION_RETRY_DELAY_MS * (attempt + 1))
            );
          } else {
            const text = await response.text();
            logger.error('repo_creation_failed_all_retries', {
              agentId,
              attempts: MAX_REPO_CREATION_RETRIES,
              status: response.status,
              error: text,
            });
          }
        } catch (err) {
          logger.error('repo_creation_error', {
            agentId,
            attempt: attempt + 1,
            error: (err as Error).message,
          });

          if (attempt < MAX_REPO_CREATION_RETRIES - 1) {
            await new Promise(resolve =>
              setTimeout(resolve, REPO_CREATION_RETRY_DELAY_MS * (attempt + 1))
            );
          }
        }
      }

      return { url: `http://${gitHost}:${gitHttpPort}/${repoName}.git`, created };
    },

    async ensureLocalMirror(agentId: string): Promise<string> {
      // Public entry point into the local-mirror machinery. `server-init.ts`
      // and `commitFiles` share this so there's one seededMirrors set and
      // one clone-config path — avoids the drift bug where a caller that
      // only cloned (no unset of `remote.origin.mirror`) left the mirror
      // in a state that broke subsequent refspec-pushes.
      const { url: originUrl } = await provider.getRepoUrl(agentId);
      return ensureMirror(agentId, originUrl);
    },

    async commitFiles(agentId: string, input: CommitFilesInput): Promise<CommitFilesResult> {
      // Resolve the remote clone URL, seed or refresh the local mirror, then
      // apply the commit against the mirror and push it upstream.
      const { url: originUrl } = await provider.getRepoUrl(agentId);
      const mirrorPath = await ensureMirror(agentId, originUrl);
      const result = await commitFilesInBareRepo(mirrorPath, input);
      if (result.changed) {
        await runGit(['-C', mirrorPath, 'push', 'origin', 'refs/heads/main']);
      }
      return result;
    },

    async close(): Promise<void> {
      // No resources to clean up
    },
  };

  return provider;
}

export type GitHttpWorkspaceProvider = Awaited<ReturnType<typeof create>>;
