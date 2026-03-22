// src/agent/workspace.ts — Workspace provisioning for agent containers.
//
// Migrated from src/sandbox-worker/workspace.ts for the unified agent container model.
// Handles GCS cache restore for fast workspace setup.
// On provision: check GCS cache first, fall back to empty workspace.
// On cleanup: diff scopes, upload changes to GCS, delete workspace.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, writeFileSync, chmodSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';

/** File change metadata for scope diffing. */
export interface FileMeta {
  path: string;
  type: 'added' | 'modified' | 'deleted';
  size: number;
}

/** Workspace setup configuration. */
export interface WorkspaceConfig {
  cacheKey?: string;
}

/** Workspace provisioning result. */
export interface WorkspaceResult {
  path: string;
  source: 'cache' | 'empty';
  durationMs: number;
}

/**
 * GCS cache bucket for workspace snapshots.
 * Set via WORKSPACE_CACHE_BUCKET env var.
 */
const CACHE_BUCKET = process.env.WORKSPACE_CACHE_BUCKET ?? '';

/** Strict allowlist for cache keys — alphanumeric, dash, underscore only. */
const CACHE_KEY_RE = /^[a-zA-Z0-9_-]+$/;

function validateCacheKey(key: string): void {
  if (!CACHE_KEY_RE.test(key)) {
    throw new Error(`Invalid cache key: ${key} — must match ${CACHE_KEY_RE}`);
  }
}

/**
 * Provision a workspace directory for an agent container.
 *
 * Priority:
 * 1. GCS cache restore (fastest, ~5-10s)
 * 2. Empty workspace (instant)
 */
export async function provisionWorkspace(
  workspaceRoot: string,
  sessionId: string,
  config?: WorkspaceConfig,
): Promise<WorkspaceResult> {
  const start = Date.now();
  const workspace = join(workspaceRoot, sessionId);
  mkdirSync(workspace, { recursive: true });

  const cacheKey = config?.cacheKey;

  // Try GCS cache restore first
  if (CACHE_BUCKET && cacheKey) {
    validateCacheKey(cacheKey);
    const cached = tryGCSRestore(workspace, cacheKey);
    if (cached) {
      return { path: workspace, source: 'cache', durationMs: Date.now() - start };
    }
  }

  return { path: workspace, source: 'empty', durationMs: Date.now() - start };
}

/**
 * Clean up a workspace on release.
 * Optionally update GCS cache for future use.
 */
export async function releaseWorkspace(
  workspace: string,
  options?: { updateCache?: boolean; cacheKey?: string },
): Promise<void> {
  // Update GCS cache before cleanup (synchronous — must complete before rmSync)
  if (CACHE_BUCKET && options?.updateCache && options?.cacheKey) {
    try {
      updateGCSCache(workspace, options.cacheKey);
    } catch {
      // Cache update failure is non-fatal
    }
  }

  // Clean up workspace directory
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    // Non-fatal: k8s will clean up the emptyDir volume anyway
  }
}

// ── Workspace scope provisioning (GCS-backed tiers) ──

const WORKSPACE_BUCKET = process.env.GCS_WORKSPACE_BUCKET ?? '';

export type FileHashMap = Map<string, string>; // relative path -> sha256

/**
 * Provision a workspace scope by downloading files into mountPath.
 *
 * Two modes:
 *   1. HTTP (k8s): fetch files from the host's /internal/workspace/provision endpoint.
 *      The host has GCS credentials; the pod does not.
 *   2. Direct (non-k8s fallback): use @google-cloud/storage SDK when credentials are local.
 */
export async function provisionScope(
  mountPath: string,
  gcsPrefix: string,
  readOnly: boolean,
  opts?: { hostUrl?: string; token?: string; scope?: string; id?: string },
): Promise<{ source: 'gcs' | 'empty'; fileCount: number; hashes: FileHashMap }> {
  mkdirSync(mountPath, { recursive: true });
  const hashes: FileHashMap = new Map();

  try {
    if (opts?.hostUrl && opts.scope && opts.id) {
      // K8s mode: download from host via HTTP (host has GCS credentials, pod doesn't)
      const params = new URLSearchParams({ scope: opts.scope, id: opts.id });
      const url = `${opts.hostUrl}/internal/workspace/provision?${params}`;
      const headers: Record<string, string> = {};
      if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
      const response = await fetch(url, { headers });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`provision HTTP ${response.status}: ${text}`);
      }
      const gzipped = Buffer.from(await response.arrayBuffer());
      const json = JSON.parse(gunzipSync(gzipped).toString('utf-8')) as {
        files: Array<{ path: string; content_base64: string; size: number }>;
      };
      for (const file of json.files) {
        const localPath = join(mountPath, ...file.path.split('/'));
        await mkdir(join(localPath, '..'), { recursive: true });
        writeFileSync(localPath, Buffer.from(file.content_base64, 'base64'));
      }
    } else if (WORKSPACE_BUCKET) {
      // Non-k8s fallback: use GCS SDK directly (host has credentials locally)
      const { Storage } = await import('@google-cloud/storage');
      const storage = new Storage();
      const bucket = storage.bucket(WORKSPACE_BUCKET);
      const [files] = await bucket.getFiles({ prefix: gcsPrefix });
      for (const file of files) {
        const relPath = file.name.slice(gcsPrefix.length);
        if (!relPath) continue;
        const localPath = join(mountPath, ...relPath.split('/'));
        await mkdir(join(localPath, '..'), { recursive: true });
        const [content] = await file.download();
        writeFileSync(localPath, content);
      }
    } else {
      return { source: 'empty', fileCount: 0, hashes };
    }
  } catch {
    return { source: 'empty', fileCount: 0, hashes };
  }

  // Snapshot file hashes for diff on release
  const localFiles = listFilesSync(mountPath);
  for (const relPath of localFiles) {
    const content = readFileSync(join(mountPath, relPath));
    hashes.set(relPath, hashContent(content));
  }

  // Make shell scripts executable — GCS doesn't preserve Unix permissions
  for (const relPath of localFiles) {
    if (relPath.endsWith('.sh')) {
      try { chmodSync(join(mountPath, relPath), 0o755); } catch { /* ignore */ }
    }
  }

  if (readOnly) {
    try {
      for (const relPath of localFiles) {
        chmodSync(join(mountPath, relPath), 0o444);  // r--r--r--
      }
      // Lock directories too — directory write permission controls create/delete/rename
      lockDirsSync(mountPath);
    } catch {
      // EPERM in k8s — volume owned by different UID. Proceed without enforcing
      // read-only so the hash snapshot is still returned for workspace release.
    }
  }

  return { source: 'gcs', fileCount: localFiles.length, hashes };
}

export function diffScope(
  mountPath: string,
  baseHashes: FileHashMap,
): FileMeta[] {
  const changes: FileMeta[] = [];
  const currentFiles = listFilesSync(mountPath);
  const currentSet = new Set(currentFiles);

  for (const relPath of currentFiles) {
    const content = readFileSync(join(mountPath, relPath));
    const hash = hashContent(content);
    const oldHash = baseHashes.get(relPath);
    if (!oldHash) {
      changes.push({ path: relPath, type: 'added', size: content.length });
    } else if (hash !== oldHash) {
      changes.push({ path: relPath, type: 'modified', size: content.length });
    }
  }

  for (const relPath of baseHashes.keys()) {
    if (!currentSet.has(relPath)) {
      changes.push({ path: relPath, type: 'deleted', size: 0 });
    }
  }

  return changes;
}

// ── Internal helpers ──

function tryGCSRestore(workspace: string, cacheKey: string): boolean {
  validateCacheKey(cacheKey);
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;

  try {
    execFileSync('gsutil', ['-q', 'cp', cachePath, '/tmp/workspace-cache.tar.gz'], {
      timeout: 30_000,
      stdio: 'pipe',
    });
    execFileSync('tar', ['xzf', '/tmp/workspace-cache.tar.gz', '-C', workspace], {
      timeout: 60_000,
      stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-cache.tar.gz'); } catch { /* ignore */ }
    console.log(`[workspace] restored from cache: ${cacheKey}`);
    return true;
  } catch {
    console.log(`[workspace] cache miss for: ${cacheKey}`);
    return false;
  }
}

/** Recursively chmod directories to r-xr-xr-x (no write) to prevent file creation/deletion. */
function lockDirsSync(dir: string): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      lockDirsSync(join(dir, entry.name));
    }
  }
  // chmod after recursing so child dirs are still writable during traversal
  chmodSync(dir, 0o555);
}

/** Sync helper: list all files recursively under a directory. */
function listFilesSync(baseDir: string, prefix = ''): string[] {
  const files: string[] = [];
  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listFilesSync(join(baseDir, entry.name), relPath));
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }
  return files;
}

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function updateGCSCache(workspace: string, cacheKey: string): void {
  validateCacheKey(cacheKey);
  const cachePath = `gs://${CACHE_BUCKET}/${cacheKey}/workspace.tar.gz`;

  try {
    execFileSync('tar', ['czf', '/tmp/workspace-upload.tar.gz', '-C', workspace, '.'], {
      timeout: 120_000,
      stdio: 'pipe',
    });
    execFileSync('gsutil', ['-q', 'cp', '/tmp/workspace-upload.tar.gz', cachePath], {
      timeout: 120_000,
      stdio: 'pipe',
    });
    try { rmSync('/tmp/workspace-upload.tar.gz'); } catch { /* ignore */ }
    console.log(`[workspace] cache updated: ${cacheKey}`);
  } catch (err) {
    console.error(`[workspace] cache update failed: ${(err as Error).message}`);
  }
}
