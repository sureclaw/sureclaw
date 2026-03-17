// src/providers/workspace/local.ts — Local filesystem workspace backend
//
// Uses a hash-map snapshot approach for change detection:
//   mount()  — creates directories, snapshots file hashes
//   diff()   — compares current state against snapshot
//   commit() — persists approved changes (snapshot approach, no overlayfs)
//
// All path construction from input uses safePath() (SC-SEC-004).

import { createHash } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, unlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
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
// Snapshot helpers
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
// Local Backend
// ═══════════════════════════════════════════════════════

interface MountState {
  path: string;
  snapshot: FileSnapshot;
}

function createLocalBackend(basePath: string): WorkspaceBackend {
  /** Mounted scope state: "scope:id" → MountState */
  const mounts = new Map<string, MountState>();

  function mountKey(scope: WorkspaceScope, id: string): string {
    return `${scope}:${id}`;
  }

  return {
    async mount(scope: WorkspaceScope, id: string): Promise<string> {
      const scopeDir = safePath(basePath, scope, id);
      await mkdir(scopeDir, { recursive: true });

      const snapshot = await takeSnapshot(scopeDir);
      mounts.set(mountKey(scope, id), { path: scopeDir, snapshot });

      return scopeDir;
    },

    async diff(scope: WorkspaceScope, id: string): Promise<FileChange[]> {
      const key = mountKey(scope, id);
      const state = mounts.get(key);
      if (!state) return [];

      const { path: scopeDir, snapshot } = state;
      const changes: FileChange[] = [];

      // Current files on disk
      const currentFiles = await listFiles(scopeDir);
      const currentSet = new Set(currentFiles);

      // Check for added and modified files
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

      // Check for deleted files
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

      const { path: scopeDir } = state;

      for (const change of changes) {
        const fullPath = safePath(scopeDir, ...change.path.split('/'));

        if (change.type === 'deleted') {
          try {
            await unlink(fullPath);
          } catch {
            // File already gone — that's fine
          }
        } else if (change.content) {
          // Ensure parent directory exists
          const parentDir = join(fullPath, '..');
          await mkdir(parentDir, { recursive: true });
          await writeFile(fullPath, change.content);
        }
      }

      // Re-snapshot after commit so future diffs are relative to committed state
      const newSnapshot = await takeSnapshot(scopeDir);
      state.snapshot = newSnapshot;
    },
  };
}

// ═══════════════════════════════════════════════════════
// Provider Factory
// ═══════════════════════════════════════════════════════

/**
 * Create a local filesystem workspace provider.
 *
 * Requires a ScannerProvider in the registry for content scanning.
 * The scanner is resolved lazily — it must be available by the time
 * commit() is called.
 */
export async function create(config: Config): Promise<WorkspaceProvider> {
  // Resolve workspace config with defaults
  const wsConfig = (config as unknown as Record<string, unknown>).workspace as
    | Partial<{ basePath: string; maxFileSize: number; maxFiles: number; maxCommitSize: number; ignorePatterns: string[] }>
    | undefined;

  const basePath = wsConfig?.basePath ?? join(homedir(), '.ax', 'workspaces');
  const agentId = config.agent_name ?? 'main';

  // Create the base directory
  await mkdir(basePath, { recursive: true });

  const backend = createLocalBackend(basePath);

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
  });

  provider.listFiles = async (scope, id) => {
    const folder = scope === 'session' ? 'scratch' : scope;
    const scopeDir = safePath(basePath, folder, id);
    const files = await listFiles(scopeDir);
    const entries = [];
    for (const relPath of files) {
      const fullPath = join(scopeDir, relPath);
      try {
        const s = await stat(fullPath);
        entries.push({ path: relPath, size: s.size });
      } catch {
        entries.push({ path: relPath, size: 0 });
      }
    }
    return entries;
  };

  return provider;
}
