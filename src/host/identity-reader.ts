/**
 * Git-native identity reader with in-memory cache.
 *
 * Single source of truth for reading agent identity files from the git
 * workspace repo. Used by the completion pipeline, admin API, channels,
 * scheduler, and CLI — replaces all DocumentStore identity reads.
 *
 * For file:// repos: reads directly from the bare repo (no clone needed).
 * For http:// repos: shallow bare fetch, read, cleanup.
 *
 * Cache: identity payloads are cached per agentId with a 30s TTL.
 * Cache is invalidated after identity writes (hostGitCommit, seedRemoteRepo).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkspaceProvider } from '../providers/workspace/types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'identity-reader' });

export interface IdentityPayload {
  agents?: string;
  heartbeat?: string;
  soul?: string;
  identity?: string;
  bootstrap?: string;
  userBootstrap?: string;
}

/** Paths to identity files in the git tree. */
export const IDENTITY_FILE_MAP: Array<{ gitPath: string; field: keyof IdentityPayload }> = [
  { gitPath: '.ax/AGENTS.md', field: 'agents' },
  { gitPath: '.ax/HEARTBEAT.md', field: 'heartbeat' },
  { gitPath: '.ax/SOUL.md', field: 'soul' },
  { gitPath: '.ax/IDENTITY.md', field: 'identity' },
  // BOOTSTRAP.md and USER_BOOTSTRAP.md are always loaded from templates/ (static).
];

// ── In-memory cache ──

const CACHE_TTL_MS = 30_000; // 30 seconds

interface CacheEntry {
  payload: IdentityPayload;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Clear the entire identity cache. Called after identity writes and in tests. */
export function clearIdentityCache(): void {
  cache.clear();
}

// ── Git readers ──

/**
 * Load identity files from committed git state using a gitDir.
 * Uses `git show HEAD:<path>` — works with both bare repos and separate gitdirs.
 */
export function loadIdentityFromGit(gitDir: string): IdentityPayload {
  const identity: IdentityPayload = {};
  const opts = { cwd: gitDir, encoding: 'utf-8' as const, stdio: 'pipe' as const, env: { ...process.env, GIT_DIR: gitDir } };

  for (const { gitPath, field } of IDENTITY_FILE_MAP) {
    try {
      const content = execFileSync('git', ['show', `HEAD:${gitPath}`], opts).toString();
      if (content) identity[field] = content;
    } catch {
      // File doesn't exist in git — leave as undefined
    }
  }

  return identity;
}

/**
 * Fetch identity files from a remote git repo without cloning the full workspace.
 * Shallow bare fetch (depth 1) — only downloads the latest commit's tree.
 * Returns the bare gitDir path for later cleanup, plus the identity payload.
 */
export function fetchIdentityFromRemote(
  repoUrl: string,
): { gitDir: string; identity: IdentityPayload } {
  const gitDir = mkdtempSync(join(tmpdir(), 'ax-id-'));
  execFileSync('git', ['init', '--bare'], { cwd: gitDir, stdio: 'pipe' });
  execFileSync('git', ['remote', 'add', 'origin', repoUrl], { cwd: gitDir, stdio: 'pipe' });
  try {
    execFileSync('git', ['fetch', '--depth', '1', '--filter=blob:none', 'origin', 'main'], { cwd: gitDir, stdio: 'pipe' });
    execFileSync('git', ['update-ref', 'HEAD', 'FETCH_HEAD'], { cwd: gitDir, stdio: 'pipe' });
  } catch {
    try {
      execFileSync('git', ['fetch', '--depth', '1', 'origin', 'main'], { cwd: gitDir, stdio: 'pipe' });
      execFileSync('git', ['update-ref', 'HEAD', 'FETCH_HEAD'], { cwd: gitDir, stdio: 'pipe' });
    } catch {
      logger.debug('identity_fetch_empty_repo', { repoUrl });
      return { gitDir, identity: {} };
    }
  }

  const identity = loadIdentityFromGit(gitDir);
  return { gitDir, identity };
}

// ── High-level API ──

/**
 * Read identity for an agent from the workspace git repo.
 * Returns cached result if available and not expired.
 *
 * For file:// repos: reads directly from the bare repo path.
 * For http:// repos: shallow bare fetch → read → cleanup temp dir.
 */
export async function readIdentityForAgent(
  agentId: string,
  workspaceProvider: WorkspaceProvider,
): Promise<IdentityPayload> {
  // Check cache
  const cached = cache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  const { url: repoUrl } = await workspaceProvider.getRepoUrl(agentId);
  let payload: IdentityPayload;

  if (repoUrl.startsWith('file://')) {
    // file:// bare repo — read directly, no temp dir needed
    const bareRepoPath = repoUrl.replace('file://', '');
    payload = loadIdentityFromGit(bareRepoPath);
  } else {
    // http:// — temp bare fetch
    const { gitDir, identity } = fetchIdentityFromRemote(repoUrl);
    try { rmSync(gitDir, { recursive: true, force: true }); } catch { /* best effort */ }
    payload = identity;
  }

  // Cache the result
  cache.set(agentId, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
  return payload;
}
