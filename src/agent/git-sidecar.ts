/**
 * Git sidecar — runs alongside the agent in the same pod as a separate
 * container. The git metadata (.git) lives on a volume mounted ONLY in
 * this container, so the agent cannot access or sabotage it.
 *
 * Volume layout:
 *   /workspace  -> shared emptyDir (agent + sidecar both see workspace files)
 *   /gitdir     -> separate emptyDir (sidecar only — contains .git objects)
 *
 * Communication:
 *   Sidecar listens on localhost:9099 (configurable via AX_GIT_SIDECAR_PORT).
 *   Containers in the same pod share a network namespace, so localhost works.
 *   Agent POSTs to /turn-complete when a turn ends.
 *   Sidecar responds with commit result { ok, hash, files } or { ok: false, error }.
 *
 * Conflict resolution:
 *   Agent workspaces are per-agent scratch areas, not collaborative codebases.
 *   Last writer wins — force-reset on pull, force-push on push failure.
 *
 * Lifecycle:
 *   1. git-init container clones repo with --separate-git-dir=/gitdir into /workspace
 *   2. Runner POSTs /pull — sidecar fetches + resets worktree to origin/main
 *   3. Agent works in /workspace (no .git visible)
 *   4. Runner POSTs /turn-complete — sidecar stages, commits, force-pushes
 *   5. Sidecar responds with commit status
 *
 * All git operations use GIT_DIR/GIT_WORK_TREE env vars via git-cli.ts,
 * which invokes the native git binary (supports LFS transparently).
 */

import { createServer } from 'node:http';
import { getLogger } from '../logger.js';
import { gitExec, gitFetch, gitResetHard, gitClean, gitAdd, gitStatus, gitCommit, gitPush } from './git-cli.js';
import { AX_DIFF_PATHSPEC } from '../host/validate-commit.js';

const logger = getLogger().child({ component: 'git-sidecar' });

const DEFAULT_PORT = 9099;

interface CommitResult {
  ok: boolean;
  hash?: string;
  files?: number;
  error?: string;
}

/**
 * Force-reset the worktree to match origin/main.
 * Safe at turn start because the agent hasn't modified anything yet.
 */
async function forcePull(workspaceDir: string, gitDir: string): Promise<void> {
  const opts = { gitDir, workTree: workspaceDir };
  await gitFetch(opts);
  await gitResetHard('origin/main', opts);
  await gitClean(opts);
  logger.info('force_pull_complete');
}

/**
 * Call the host's validate_commit endpoint to validate .ax/ diffs.
 * Returns { ok: true } if valid or host is unreachable, { ok: false, reason } if rejected.
 */
async function callHostValidateCommit(diff: string): Promise<{ ok: boolean; reason?: string }> {
  const hostUrl = process.env.AX_HOST_URL;
  if (!hostUrl) {
    logger.debug('validate_commit_skip', { reason: 'AX_HOST_URL not set' });
    return { ok: true };
  }

  try {
    const resp = await fetch(`${hostUrl}/ipc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'validate_commit', diff }),
    });
    if (!resp.ok) {
      logger.warn('validate_commit_http_error', { status: resp.status });
      return { ok: true }; // Fail open on HTTP errors
    }
    const result = await resp.json() as { ok: boolean; reason?: string };
    return result;
  } catch (err) {
    logger.warn('validate_commit_call_failed', { error: (err as Error).message });
    // Fail open — if we can't reach the host, allow the commit
    return { ok: true };
  }
}

async function commitAndPush(workspaceDir: string, gitDir: string): Promise<CommitResult> {
  const opts = { gitDir, workTree: workspaceDir };

  // git add -A handles adds, modifications, AND deletions in one command
  await gitAdd(opts);

  // Validate .ax/ changes before committing
  try {
    const axDiff = (await gitExec(['diff', '--cached', '--', AX_DIFF_PATHSPEC], opts)).trim();

    if (axDiff) {
      const validation = await callHostValidateCommit(axDiff);
      if (!validation.ok) {
        logger.warn('ax_commit_rejected', { reason: validation.reason });
        // Revert .ax/ changes — unstage and checkout
        try { await gitExec(['reset', 'HEAD', '--', '.ax/'], opts); } catch { /* no .ax/ staged */ }
        try { await gitExec(['checkout', '--', '.ax/'], opts); } catch { /* no .ax/ to restore */ }
        // Re-stage remaining (non-.ax/) changes
        await gitAdd(opts);
      }
    }
  } catch (err) {
    logger.debug('ax_diff_check_skip', { error: (err as Error).message });
  }

  const changed = await gitStatus(opts);
  if (changed.length === 0) {
    logger.debug('no_changes_to_commit');
    return { ok: true, files: 0 };
  }

  const timestamp = new Date().toISOString();
  const message = `agent-turn: ${timestamp}`;
  const hash = await gitCommit(message, opts);
  logger.info('committed', { hash, message, fileCount: changed.length });

  // Push — force-push on conflict (last writer wins for agent workspaces)
  try {
    await gitPush(opts);
    logger.info('pushed');
  } catch (pushErr) {
    logger.warn('push_rejected_retrying_force', { error: (pushErr as Error).message });
    try {
      await gitPush({ ...opts, force: true });
      logger.info('force_pushed');
    } catch (forceErr) {
      const error = (forceErr as Error).message;
      logger.error('force_push_failed', { error });
      return { ok: false, hash, files: changed.length, error: `push failed: ${error}` };
    }
  }

  return { ok: true, hash, files: changed.length };
}

export async function runGitSidecar(): Promise<void> {
  const workspaceDir = process.env.AX_WORKSPACE || '/workspace';
  const gitDir = process.env.AX_GITDIR || '/gitdir';
  const repoUrl = process.env.WORKSPACE_REPO_URL || '';
  const port = parseInt(process.env.AX_GIT_SIDECAR_PORT || '', 10) || DEFAULT_PORT;

  if (!repoUrl) {
    logger.info('no_repo_url', { message: 'WORKSPACE_REPO_URL not set, sidecar exiting' });
    process.exit(0);
  }

  logger.info('sidecar_start', { workspaceDir, gitDir, port });

  let activeCommit: Promise<CommitResult> | null = null;

  const server = createServer(async (req, res) => {
    // Force-reset worktree to origin/main before a turn starts.
    // Overwrites local files — safe because the agent hasn't started work yet.
    if (req.method === 'POST' && req.url === '/pull') {
      try {
        await forcePull(workspaceDir, gitDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const error = (err as Error).message;
        logger.warn('force_pull_failed', { error, stack: (err as Error).stack });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error }));
      }
      return;
    }

    if (req.method === 'POST' && req.url === '/turn-complete') {
      try {
        activeCommit = commitAndPush(workspaceDir, gitDir);
        const result = await activeCommit;
        activeCommit = null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        activeCommit = null;
        const error = (err as Error).message;
        logger.error('commit_failed', { error });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error }));
      }
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // Graceful shutdown: finish active commit/push before exiting
  process.on('SIGTERM', async () => {
    logger.info('sigterm_received');
    if (activeCommit) {
      logger.info('waiting_for_active_commit');
      try { await activeCommit; } catch { /* already logged */ }
    }
    server.close();
    process.exit(0);
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info('sidecar_listening', { port });
  });
}

// Run if this is the main module
const isMain = process.argv[1]?.endsWith('git-sidecar.js') ||
               process.argv[1]?.endsWith('git-sidecar.ts');
if (isMain) {
  runGitSidecar().catch((err) => {
    logger.error('sidecar_fatal', { error: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
}
