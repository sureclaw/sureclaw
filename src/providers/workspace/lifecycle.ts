// src/providers/workspace/lifecycle.ts — Unified workspace lifecycle for all sandbox providers.
//
// Replaces the hard-coded three-phase orchestration in server-completions.ts.
// Host-side providers (Docker/Apple/subprocess): prepare/finalize on host paths.
// Sandbox-side providers (k8s): prepare/finalize happen in-pod via NATS payload.

import { execFileSync, execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'workspace-lifecycle' });

// ═══════════════════════════════════════════════════════
// Lifecycle Plan — built once per turn
// ═══════════════════════════════════════════════════════

export interface WorkspaceLifecyclePlan {
  /** Git URL for scratch workspace. */
  gitUrl?: string;
  /** Git branch/ref. */
  gitRef?: string;
  /** Deterministic cache key for GCS workspace cache. */
  cacheKey?: string;
  /** GCS prefix for workspace scopes (base — scope/id appended per scope). */
  gcsPrefix?: string;
  /** Agent name (for agent scope GCS prefix). */
  agentName: string;
  /** User ID (for user scope GCS prefix). */
  userId: string;
  /** Session ID (for session scope GCS prefix). */
  sessionId: string;
  /** Whether the agent workspace is writable (admin user). */
  agentWorkspaceWritable: boolean;
  /** Scratch workspace host path (for host-side prepare/finalize). */
  scratchPath?: string;
}

/**
 * Build a lifecycle plan from the current request context.
 */
export function buildLifecyclePlan(opts: {
  gitUrl?: string;
  gitRef?: string;
  gcsPrefix?: string;
  agentName: string;
  userId: string;
  sessionId: string;
  agentWorkspaceWritable: boolean;
  scratchPath?: string;
}): WorkspaceLifecyclePlan {
  const cacheKey = opts.gitUrl
    ? createHash('sha256').update(`${opts.gitUrl}:${opts.gitRef ?? 'HEAD'}`).digest('hex').slice(0, 16)
    : undefined;

  return {
    gitUrl: opts.gitUrl,
    gitRef: opts.gitRef,
    cacheKey,
    gcsPrefix: opts.gcsPrefix,
    agentName: opts.agentName,
    userId: opts.userId,
    sessionId: opts.sessionId,
    agentWorkspaceWritable: opts.agentWorkspaceWritable,
    scratchPath: opts.scratchPath,
  };
}

// ═══════════════════════════════════════════════════════
// Host-side git workspace prepare/finalize
// ═══════════════════════════════════════════════════════

const CACHE_BUCKET = process.env.WORKSPACE_CACHE_BUCKET ?? '';

/**
 * Prepare a git workspace on a host-visible path (Docker/Apple/subprocess).
 * Restores from GCS cache, falls back to git clone --depth=1.
 */
export async function prepareGitWorkspace(plan: WorkspaceLifecyclePlan): Promise<void> {
  if (!plan.gitUrl || !plan.scratchPath) return;

  // Already populated (e.g. subprocess reusing an existing workspace)
  if (existsSync(join(plan.scratchPath, '.git'))) {
    tryGitPull(plan.scratchPath, plan.gitRef);
    return;
  }

  // Try GCS cache restore
  if (CACHE_BUCKET && plan.cacheKey) {
    if (tryGCSRestore(plan.scratchPath, plan.cacheKey)) {
      tryGitPull(plan.scratchPath, plan.gitRef);
      return;
    }
  }

  // Fall back to git clone
  tryGitClone(plan.scratchPath, plan.gitUrl, plan.gitRef);
}

/**
 * Finalize a git workspace on a host-visible path (Docker/Apple/subprocess).
 * Pushes changes to remote, updates GCS cache.
 */
export async function finalizeGitWorkspace(plan: WorkspaceLifecyclePlan): Promise<void> {
  if (!plan.gitUrl || !plan.scratchPath) return;

  const isGitRepo = existsSync(join(plan.scratchPath, '.git'));
  if (!isGitRepo) return;

  tryGitPush(plan.scratchPath);

  if (CACHE_BUCKET && plan.cacheKey) {
    // Fire-and-forget — don't block response on cache update
    updateGCSCache(plan.scratchPath, plan.cacheKey).catch(() => {});
  }
}

// ═══════════════════════════════════════════════════════
// Git helpers — use execFileSync (no shell) for safety
// ═══════════════════════════════════════════════════════

function tryGCSRestore(workspace: string, cacheKey: string): boolean {
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;
  try {
    execFileSync('gsutil', ['-q', 'cp', cachePath, '/tmp/workspace-cache.tar.gz'], {
      timeout: 30_000, stdio: 'pipe',
    });
    execFileSync('tar', ['xzf', '/tmp/workspace-cache.tar.gz', '-C', workspace], {
      timeout: 60_000, stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-cache.tar.gz'); } catch { /* ignore */ }
    logger.info('git_workspace_cached', { cacheKey });
    return true;
  } catch {
    return false;
  }
}

function tryGitClone(workspace: string, gitUrl: string, ref?: string): boolean {
  try {
    const args = ['clone', '--depth=1'];
    if (ref) args.push('--branch', ref);
    args.push(gitUrl, workspace);
    execFileSync('git', args, { timeout: 120_000, stdio: 'pipe' });
    logger.info('git_workspace_cloned', { gitUrl, ref });
    return true;
  } catch (err) {
    logger.warn('git_workspace_clone_failed', { error: (err as Error).message });
    return false;
  }
}

function tryGitPull(workspace: string, ref?: string): void {
  try {
    execFileSync('git', ['-C', workspace, 'pull', '--ff-only', 'origin', ref ?? 'HEAD'], {
      timeout: 30_000, stdio: 'pipe',
    });
  } catch {
    // Non-fatal
  }
}

function tryGitPush(workspace: string): void {
  try {
    const status = execFileSync('git', ['-C', workspace, 'status', '--porcelain'], {
      encoding: 'utf-8', timeout: 10_000,
    }).trim();
    if (!status) return;

    // git add + commit needs shell chaining for atomicity — workspace is a host-controlled
    // path (never user input), matching existing pattern in src/agent/workspace.ts.
    // nosemgrep: javascript.lang.security.detect-child-process
    execSync(
      `git -C "${workspace}" add . && git -C "${workspace}" commit -m "sandbox: auto-commit workspace changes"`,
      { timeout: 30_000, stdio: 'pipe' },
    );
    execFileSync('git', ['-C', workspace, 'push'], { timeout: 60_000, stdio: 'pipe' });
    logger.info('git_workspace_pushed');
  } catch (err) {
    logger.warn('git_workspace_push_failed', { error: (err as Error).message });
  }
}

async function updateGCSCache(workspace: string, cacheKey: string): Promise<void> {
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;
  try {
    execFileSync('tar', ['czf', '/tmp/workspace-upload.tar.gz', '-C', workspace, '.'], {
      timeout: 120_000, stdio: 'pipe',
    });
    execFileSync('gsutil', ['-q', 'cp', '/tmp/workspace-upload.tar.gz', cachePath], {
      timeout: 120_000, stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-upload.tar.gz'); } catch { /* ignore */ }
  } catch {
    // Cache update failure is non-fatal
  }
}
