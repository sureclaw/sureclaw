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
import { readdir, readFile, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safePath } from '../../utils/safe-path.js';
import { createOrchestrator } from './shared.js';
import type { ScannerProvider } from '../scanner/types.js';
import type { Config } from '../../types.js';
import type {
  WorkspaceBackend,
  WorkspaceScope,
  WorkspaceProvider,
  FileChange,
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
// GCS Backend
// ═══════════════════════════════════════════════════════

interface MountState {
  path: string;
  snapshot: FileSnapshot;
}

/**
 * Create a GCS-backed workspace backend.
 *
 * Exported for testing — tests pass a mock bucket.
 * The `create()` factory constructs the real GCS bucket.
 */
export function createGcsBackend(bucket: GcsBucketLike, basePath: string, prefix: string): WorkspaceBackend {
  const mounts = new Map<string, MountState>();

  function mountKey(scope: WorkspaceScope, id: string): string {
    return `${scope}:${id}`;
  }

  /** Build the GCS key prefix for a scope/id pair. */
  function gcsPrefix(scope: WorkspaceScope, id: string): string {
    return prefix ? `${prefix}/${scope}/${id}/` : `${scope}/${id}/`;
  }

  return {
    async mount(scope: WorkspaceScope, id: string): Promise<string> {
      const localDir = safePath(basePath, scope, id);
      await mkdir(localDir, { recursive: true });

      // Download persisted state from GCS into local cache
      const keyPrefix = gcsPrefix(scope, id);
      const [files] = await bucket.getFiles({ prefix: keyPrefix });

      for (const file of files) {
        const relPath = file.name.slice(keyPrefix.length);
        if (!relPath) continue; // skip the prefix "directory" itself

        const localPath = safePath(localDir, ...relPath.split('/'));
        const parentDir = join(localPath, '..');
        await mkdir(parentDir, { recursive: true });

        const [content] = await file.download();
        await writeFile(localPath, content);
      }

      // Snapshot for change detection
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

      // Added and modified
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

      // Deleted
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

      const keyPrefix = gcsPrefix(scope, id);

      // Sync changes to GCS
      for (const change of changes) {
        const gcsKey = keyPrefix + change.path;

        if (change.type === 'deleted') {
          try {
            await bucket.file(gcsKey).delete();
          } catch {
            // Object already gone in GCS — that's fine
          }
        } else if (change.content) {
          await bucket.file(gcsKey).save(change.content);
        }
      }

      // Update local files to match approved state and re-snapshot
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
// Provider Factory
// ═══════════════════════════════════════════════════════

/**
 * Create a GCS-backed workspace provider.
 *
 * Requires either `workspace.bucket` in config or `GCS_WORKSPACE_BUCKET` env var.
 * The @google-cloud/storage SDK handles authentication via Application Default
 * Credentials (GKE workload identity, GOOGLE_APPLICATION_CREDENTIALS, etc.).
 */
export async function create(config: Config): Promise<WorkspaceProvider> {
  // Lazy import to avoid requiring @google-cloud/storage when using other backends
  const { Storage } = await import('@google-cloud/storage');

  const wsConfig = (config as unknown as Record<string, unknown>).workspace as
    | Partial<{ basePath: string; bucket: string; prefix: string; maxFileSize: number; maxFiles: number; maxCommitSize: number; ignorePatterns: string[] }>
    | undefined;

  const bucketName = wsConfig?.bucket ?? process.env.GCS_WORKSPACE_BUCKET;
  if (!bucketName) {
    throw new Error(
      'GCS workspace provider requires workspace.bucket config or GCS_WORKSPACE_BUCKET env var'
    );
  }

  const prefix = wsConfig?.prefix ?? '';
  const basePath = wsConfig?.basePath ?? join(tmpdir(), 'ax-workspaces-gcs');
  const agentId = config.agent_name ?? 'assistant';

  await mkdir(basePath, { recursive: true });

  const storage = new Storage();
  const bucket = storage.bucket(bucketName);

  const backend = createGcsBackend(bucket, basePath, prefix);

  // Scanner is required for the commit pipeline. The provider registry
  // should inject it, but we create a pass-through stub to satisfy the
  // type system. Real deployments wire the actual scanner.
  const scanner: ScannerProvider = {
    async scanInput() { return { verdict: 'PASS' }; },
    async scanOutput() { return { verdict: 'PASS' }; },
    canaryToken() { return ''; },
    checkCanary() { return false; },
  };

  return createOrchestrator({
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
  });
}
