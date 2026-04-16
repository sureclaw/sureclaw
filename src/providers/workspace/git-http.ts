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

import type { WorkspaceProvider } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'git-http-workspace' });

const MAX_REPO_CREATION_RETRIES = 3;
const REPO_CREATION_RETRY_DELAY_MS = 1000;

export async function create(config: Config): Promise<WorkspaceProvider> {
  // Construct fully qualified service name: ax-git.namespace.svc.cluster.local
  const serviceName = 'ax-git';
  const namespace = config.namespace || 'default';
  const gitHost = config.gitServer?.host || `${serviceName}.${namespace}.svc.cluster.local`;
  const gitHttpPort = config.gitServer?.httpPort || 8000;

  return {
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

    async close(): Promise<void> {
      // No resources to clean up
    },
  };
}

export type GitHttpWorkspaceProvider = Awaited<ReturnType<typeof create>>;
