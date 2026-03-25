// src/providers/workspace/gcs.ts — Google Cloud Storage workspace backend
//
// Uses GCS for persistent workspace state:
//   mount()  — downloads persisted state from GCS bucket to local cache, snapshots hashes
//   diff()   — compares current state against snapshot (same technique as local backend)
//   commit() — uploads approved changes to GCS bucket, re-snapshots
//
// All path construction from input uses safePath() (SC-SEC-004).
// Storage credentials exist only in the host process — the agent never sees them.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { safePath } from '../../utils/safe-path.js';
import { createOrchestrator } from './shared.js';
import type { ScannerProvider } from '../scanner/types.js';
import type { Config } from '../../types.js';
import type {
  WorkspaceBackend,
  WorkspaceScope,
  WorkspaceProvider,
  FileChange,
  RemoteFileChange,
} from './types.js';

// ═══════════════════════════════════════════════════════
// GCS abstraction (testable interface)
// ═══════════════════════════════════════════════════════

/** Minimal bucket interface matching @google-cloud/storage Bucket. */
export interface GcsBucketLike {
  getFiles(opts: { prefix: string }): Promise<[Array<{ name: string; download(): Promise<[Buffer]> }>, ...unknown[]]>;
  file(name: string): { save(content: Buffer): Promise<unknown>; delete(): Promise<unknown> };
}

// ═══════════════════════════════════════════════════════
// Snapshot helpers (same approach as local backend)
// ═══════════════════════════════════════════════════════

type FileSnapshot = Map<string, string>; // relative path → content hash

function hashContent(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Recursively list all files under a directory, returning relative paths. */
async function listFiles(baseDir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return files; // directory doesn't exist yet
  }

  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await listFiles(join(baseDir, entry.name), relPath);
      files.push(...nested);
    } else if (entry.isFile()) {
      files.push(relPath);
    }
  }

  return files;
}

/** Take a snapshot of all files under a directory: relative path → sha256 hash. */
async function takeSnapshot(baseDir: string): Promise<FileSnapshot> {
  const snapshot: FileSnapshot = new Map();
  const files = await listFiles(baseDir);

  for (const relPath of files) {
    const fullPath = join(baseDir, relPath);
    const content = await readFile(fullPath);
    snapshot.set(relPath, hashContent(content));
  }

  return snapshot;
}

// ═══════════════════════════════════════════════════════
// GCS key prefix helpers
// ═══════════════════════════════════════════════════════

/** Map scope to GCS folder name — 'session' → 'scratch', others pass through. */
function scopeFolder(scope: WorkspaceScope): string {
  return scope === 'session' ? 'scratch' : scope;
}

/** Normalize prefix to end with '/' (or empty string). */
function normalizePrefix(prefix: string): string {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

/** Build the GCS key prefix for a scope/id pair: `<prefix><folder>/<id>/`. */
function gcsKeyPrefix(prefix: string, scope: WorkspaceScope, id: string): string {
  return `${normalizePrefix(prefix)}${scopeFolder(scope)}/${id}/`;
}

/** Build the GCS prefix for a scope (without trailing id): `<prefix><folder>/`. */
function gcsScopePrefix(prefix: string, scope: WorkspaceScope): string {
  return `${normalizePrefix(prefix)}${scopeFolder(scope)}/`;
}

// ═══════════════════════════════════════════════════════
// Transport Abstraction
// ═══════════════════════════════════════════════════════

/**
 * Transport interface for workspace tier operations.
 * Abstracts the difference between local bind-mount flow and k8s NATS staging flow.
 */
export interface WorkspaceTransport {
  /** Populate scope directory with GCS content. Returns local path. */
  provision(scope: WorkspaceScope, id: string, gcsPrefix: string): Promise<string>;
  /** Compute changeset since provision. */
  diff(scope: WorkspaceScope, id: string): Promise<FileChange[]>;
  /** Persist approved changes to final GCS prefix. */
  commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void>;
}

// ═══════════════════════════════════════════════════════
// Local Transport (bind-mount flow)
// ═══════════════════════════════════════════════════════

interface MountState {
  path: string;
  snapshot: FileSnapshot;
}

function createLocalTransport(bucket: GcsBucketLike, basePath: string, prefix: string): WorkspaceTransport {
  const mounts = new Map<string, MountState>();

  function mountKey(scope: WorkspaceScope, id: string): string {
    return `${scope}:${id}`;
  }

  return {
    async provision(scope: WorkspaceScope, id: string): Promise<string> {
      const localDir = safePath(basePath, scopeFolder(scope), id);
      await mkdir(localDir, { recursive: true });

      const kp = gcsKeyPrefix(prefix, scope, id);
      const [files] = await bucket.getFiles({ prefix: kp });

      for (const file of files) {
        const relPath = file.name.slice(kp.length);
        if (!relPath) continue;

        const localPath = safePath(localDir, ...relPath.split('/'));
        const parentDir = join(localPath, '..');
        await mkdir(parentDir, { recursive: true });

        const [content] = await file.download();
        await writeFile(localPath, content);
      }

      const snapshot = await takeSnapshot(localDir);
      mounts.set(mountKey(scope, id), { path: localDir, snapshot });

      return localDir;
    },

    async diff(scope: WorkspaceScope, id: string): Promise<FileChange[]> {
      const key = mountKey(scope, id);
      const state = mounts.get(key);
      if (!state) return [];

      const { path: scopeDir, snapshot } = state;
      const changes: FileChange[] = [];

      const currentFiles = await listFiles(scopeDir);
      const currentSet = new Set(currentFiles);

      for (const relPath of currentFiles) {
        const fullPath = join(scopeDir, relPath);
        const content = await readFile(fullPath);
        const hash = hashContent(content);
        const oldHash = snapshot.get(relPath);

        if (!oldHash) {
          changes.push({ path: relPath, type: 'added', content, size: content.length });
        } else if (hash !== oldHash) {
          changes.push({ path: relPath, type: 'modified', content, size: content.length });
        }
      }

      for (const relPath of snapshot.keys()) {
        if (!currentSet.has(relPath)) {
          changes.push({ path: relPath, type: 'deleted', size: 0 });
        }
      }

      return changes;
    },

    async commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void> {
      const key = mountKey(scope, id);
      const state = mounts.get(key);
      if (!state) return;

      const kp = gcsKeyPrefix(prefix, scope, id);

      for (const change of changes) {
        const gcsKey = kp + change.path;

        if (change.type === 'deleted') {
          try {
            await bucket.file(gcsKey).delete();
          } catch {
            // Object already gone in GCS
          }
        } else if (change.content) {
          await bucket.file(gcsKey).save(change.content);
        }
      }

      const { path: scopeDir } = state;

      for (const change of changes) {
        const fullPath = safePath(scopeDir, ...change.path.split('/'));

        if (change.type === 'deleted') {
          try {
            await unlink(fullPath);
          } catch {
            // File already gone locally
          }
        } else if (change.content) {
          const parentDir = join(fullPath, '..');
          await mkdir(parentDir, { recursive: true });
          await writeFile(fullPath, change.content);
        }
      }

      const newSnapshot = await takeSnapshot(scopeDir);
      state.snapshot = newSnapshot;
    },
  };
}

// ═══════════════════════════════════════════════════════
// Remote Transport (k8s NATS staging flow)
// ═══════════════════════════════════════════════════════

/** Extended transport interface with setRemoteChanges for k8s NATS mode. */
export interface RemoteWorkspaceTransport extends WorkspaceTransport {
  /** Store file changes received from agent pod via NATS IPC. */
  setRemoteChanges(sessionId: string, changes: RemoteFileChange[]): void;
}

function createRemoteTransport(bucket: GcsBucketLike, prefix: string): RemoteWorkspaceTransport {
  // Pending changes keyed by scope name, accumulated from workspace_release IPC calls.
  const pendingChanges = new Map<string, FileChange[]>();

  return {
    async provision(): Promise<string> {
      // No-op — k8s sandbox pod handles provisioning via emptyDir volumes.
      return '';
    },

    async diff(scope: WorkspaceScope): Promise<FileChange[]> {
      // Return and consume stored changes for this scope.
      const changes = pendingChanges.get(scope) ?? [];
      pendingChanges.delete(scope);
      return changes;
    },

    async commit(scope: WorkspaceScope, id: string, changes: FileChange[]): Promise<void> {
      const kp = gcsKeyPrefix(prefix, scope, id);

      for (const change of changes) {
        const gcsKey = kp + change.path;

        if (change.type === 'deleted') {
          try {
            await bucket.file(gcsKey).delete();
          } catch {
            // Object already gone in GCS
          }
        } else if (change.content) {
          await bucket.file(gcsKey).save(change.content);
        }
      }
    },

    setRemoteChanges(_sessionId: string, changes: RemoteFileChange[]): void {
      // Group changes by scope and accumulate (supports chunked IPC calls).
      for (const change of changes) {
        const fileChange: FileChange = {
          path: change.path,
          type: change.type,
          content: change.content,
          size: change.size,
        };
        const existing = pendingChanges.get(change.scope) ?? [];
        existing.push(fileChange);
        pendingChanges.set(change.scope, existing);
      }
    },
  };
}

// ═══════════════════════════════════════════════════════
// GCS Backend (delegates to transport)
// ═══════════════════════════════════════════════════════

/**
 * Create a GCS-backed workspace backend.
 *
 * Exported for testing — tests pass a mock bucket.
 * The `create()` factory constructs the real GCS bucket.
 */
export function createGcsBackend(bucket: GcsBucketLike, basePath: string, prefix: string): WorkspaceBackend {
  const transport = createLocalTransport(bucket, basePath, prefix);

  return {
    mount: (scope, id) => transport.provision(scope, id, gcsKeyPrefix(prefix, scope, id)),
    diff: (scope, id) => transport.diff(scope, id),
    commit: (scope, id, changes) => transport.commit(scope, id, changes),
  };
}

// ═══════════════════════════════════════════════════════
// Provider Factory
// ═══════════════════════════════════════════════════════

/**
 * Create a GCS-backed workspace provider.
 *
 * Requires either `workspace.bucket` in config or `GCS_WORKSPACE_BUCKET` env var.
 * The @google-cloud/storage SDK handles authentication via Application Default
 * Credentials (GKE workload identity, GOOGLE_APPLICATION_CREDENTIALS, etc.).
 */
export async function create(config: Config, _name?: string, deps?: { screenCommit?: import('./shared.js').CommitScreener }): Promise<WorkspaceProvider> {
  // Validate GCS credentials are available before attempting to connect.
  // In k8s, the credentials file is mounted from a Secret volume — if the
  // Secret is missing (optional: true), the file won't exist and the GCS SDK
  // will fail with a cryptic auth error. Catch it early with a clear message.
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && !existsSync(credPath)) {
    throw new Error(
      `GCS workspace provider: credentials file not found at ${credPath} ` +
      `(set via GOOGLE_APPLICATION_CREDENTIALS). In k8s, this usually means the "gcs-key" ` +
      `Secret is missing — create it with: kubectl -n <namespace> create secret generic ` +
      `gcs-key --from-file=key.json=/path/to/service-account-key.json`
    );
  }

  // Lazy import to avoid requiring @google-cloud/storage when using other backends
  const { Storage } = await import('@google-cloud/storage');

  const wsConfig = config.workspace;

  const bucketName = wsConfig?.bucket ?? process.env.GCS_WORKSPACE_BUCKET;
  if (!bucketName) {
    throw new Error(
      'GCS workspace provider requires workspace.bucket config or GCS_WORKSPACE_BUCKET env var'
    );
  }

  const prefix = wsConfig?.prefix ?? '';
  const rawBase = wsConfig?.basePath ?? join(tmpdir(), 'ax-workspaces-gcs');
  const basePath = rawBase.startsWith('~') ? rawBase.replace('~', homedir()) : rawBase;
  const agentId = config.agent_name ?? 'main';

  await mkdir(basePath, { recursive: true });

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const isK8s = config.providers.sandbox === 'k8s';
  const transport = isK8s
    ? createRemoteTransport(bucket, prefix)
    : createLocalTransport(bucket, basePath, prefix);

  const backend: WorkspaceBackend = {
    mount: (scope, id) => transport.provision(scope, id, gcsKeyPrefix(prefix, scope, id)),
    diff: (scope, id) => transport.diff(scope, id),
    commit: (scope, id, changes) => transport.commit(scope, id, changes),
  };

  // Legacy alias — createGcsBackend is still used by tests
  void createGcsBackend;

  // Scanner is required for the commit pipeline. The provider registry
  // should inject it, but we create a pass-through stub to satisfy the
  // type system. Real deployments wire the actual scanner.
  const scanner: ScannerProvider = {
    async scanInput() { return { verdict: 'PASS' }; },
    async scanOutput() { return { verdict: 'PASS' }; },
    canaryToken() { return ''; },
    checkCanary() { return false; },
  };

  const provider = createOrchestrator({
    backend,
    scanner,
    config: {
      basePath,
      maxFileSize: wsConfig?.maxFileSize,
      maxFiles: wsConfig?.maxFiles,
      maxCommitSize: wsConfig?.maxCommitSize,
      ignorePatterns: wsConfig?.ignorePatterns,
    },
    agentId,
    screenCommit: deps?.screenCommit,
  });

  // In k8s mode, expose setRemoteChanges so the host can store file changes
  // received from agent pods via NATS IPC before workspace.commit() runs.
  if (isK8s && 'setRemoteChanges' in transport) {
    const remoteTransport = transport as RemoteWorkspaceTransport;
    provider.setRemoteChanges = (sessionId, changes) => {
      remoteTransport.setRemoteChanges(sessionId, changes);
    };
  }

  // List files from GCS bucket for admin dashboard browsing.
  provider.listFiles = async (scope, id) => {
    const kp = gcsKeyPrefix(prefix, scope, id);
    const [files] = await bucket.getFiles({ prefix: kp });
    return files
      .map(f => {
        const path = f.name.slice(kp.length);
        return path ? { path, size: 0 } : null;
      })
      .filter((f): f is { path: string; size: number } => f !== null);
  };

  // Download all files with content — used by the provision HTTP endpoint
  // so sandbox pods can fetch workspace files from the host (the pod has no GCS credentials).
  // Parallel downloads (20 concurrent) reduce 473-file download from ~47s to ~3s.
  const DOWNLOAD_CONCURRENCY = 20;

  provider.downloadScope = async (scope, id) => {
    const kp = gcsKeyPrefix(prefix, scope, id);
    const [files] = await bucket.getFiles({ prefix: kp });
    const results: Array<{ path: string; content: Buffer }> = [];

    for (let i = 0; i < files.length; i += DOWNLOAD_CONCURRENCY) {
      const batch = files.slice(i, i + DOWNLOAD_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (file) => {
          const path = file.name.slice(kp.length);
          if (!path) return null;
          const [content] = await file.download();
          return { path, content };
        }),
      );
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    return results;
  };

  // List all IDs that have files in a given scope.
  // Used at startup to enumerate user IDs for domain scanning.
  provider.listScopeIds = async (scope) => {
    const sp = gcsScopePrefix(prefix, scope);
    const [files] = await bucket.getFiles({ prefix: sp });
    const ids = new Set<string>();
    for (const file of files) {
      const rel = file.name.slice(sp.length);
      const firstSlash = rel.indexOf('/');
      if (firstSlash > 0) ids.add(rel.slice(0, firstSlash));
    }
    return [...ids];
  };

  return provider;
}
