// src/providers/workspace/shared.ts — Shared orchestration logic
//
// Core commit pipeline used by real workspace backends (local, gcs, etc.).
// Handles scope tracking, structural checks, content scanning delegation,
// and change filtering before persistence.

import type { ScannerProvider } from '../scanner/types.js';
import type {
  WorkspaceProvider,
  WorkspaceBackend,
  WorkspaceScope,
  WorkspaceMounts,
  MountOptions,
  WorkspaceConfig,
  CommitResult,
  ScopeCommitResult,
  FileChange,
  FileRejection,
} from './types.js';

// ═══════════════════════════════════════════════════════
// Defaults
// ═══════════════════════════════════════════════════════

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;      // 10 MB
const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_COMMIT_SIZE = 50 * 1024 * 1024;     // 50 MB

const DEFAULT_IGNORE_PATTERNS: string[] = [
  '.git/',
  'node_modules/',
  'venv/',
  '__pycache__/',
  '*.log',
  '*.tmp',
  'build/',
  'dist/',
  // Host-managed read-only files — DocumentStore is the source of truth.
  // Written to agent workspace each turn so the LLM can read_file them.
  'identity/',
  'skills/',
];

/** Bytes to inspect for binary detection (null bytes in this range → binary). */
const BINARY_CHECK_BYTES = 8192;

// ═══════════════════════════════════════════════════════
// Scope ID resolution
// ═══════════════════════════════════════════════════════

export interface ScopeContext {
  sessionId: string;
  agentId: string;
  userId?: string;
}

/** Resolve the backend ID for a given scope. */
function scopeId(scope: WorkspaceScope, ctx: ScopeContext): string {
  switch (scope) {
    case 'agent':   return ctx.agentId;
    case 'user':    return ctx.userId ?? ctx.sessionId;
    case 'session': return ctx.sessionId;
  }
}

// ═══════════════════════════════════════════════════════
// Structural checks
// ═══════════════════════════════════════════════════════

/** Check if a file path matches any ignore pattern. */
function isIgnored(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Directory pattern: "foo/" matches any path containing "/foo/" or starting with "foo/"
    if (pattern.endsWith('/')) {
      const dir = pattern.slice(0, -1);
      if (filePath.startsWith(dir + '/') || filePath.includes('/' + dir + '/')) {
        return true;
      }
    }
    // Glob pattern: "*.ext" matches any path ending with ".ext"
    else if (pattern.startsWith('*.')) {
      const ext = pattern.slice(1); // e.g. ".log"
      if (filePath.endsWith(ext)) {
        return true;
      }
    }
    // Exact match
    else if (filePath === pattern) {
      return true;
    }
  }
  return false;
}

/** Detect binary content by checking for null bytes in the first N bytes. */
function isBinary(content: Buffer): boolean {
  const limit = Math.min(content.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < limit; i++) {
    if (content[i] === 0x00) return true;
  }
  return false;
}

/**
 * Apply structural checks to a changeset. Returns approved changes and rejections.
 */
function structuralFilter(
  changes: FileChange[],
  config: Required<Pick<WorkspaceConfig, 'maxFileSize' | 'maxFiles' | 'maxCommitSize' | 'ignorePatterns'>>,
): { approved: FileChange[]; rejections: FileRejection[] } {
  const approved: FileChange[] = [];
  const rejections: FileRejection[] = [];

  let totalSize = 0;

  for (const change of changes) {
    // Ignore patterns
    if (isIgnored(change.path, config.ignorePatterns)) {
      rejections.push({ path: change.path, reason: 'matched ignore pattern' });
      continue;
    }

    // Deletes always pass structural checks (no content to validate)
    if (change.type === 'deleted') {
      approved.push(change);
      continue;
    }

    // File size limit
    if (change.size > config.maxFileSize) {
      rejections.push({
        path: change.path,
        reason: `file size ${change.size} exceeds limit ${config.maxFileSize}`,
      });
      continue;
    }

    // Binary detection
    if (change.content && isBinary(change.content)) {
      rejections.push({ path: change.path, reason: 'binary file detected' });
      continue;
    }

    // Running totals
    totalSize += change.size;

    // Max commit size (cumulative)
    if (totalSize > config.maxCommitSize) {
      rejections.push({
        path: change.path,
        reason: `cumulative commit size ${totalSize} exceeds limit ${config.maxCommitSize}`,
      });
      continue;
    }

    // Max file count (cumulative)
    if (approved.length >= config.maxFiles) {
      rejections.push({
        path: change.path,
        reason: `file count exceeds limit ${config.maxFiles}`,
      });
      continue;
    }

    approved.push(change);
  }

  return { approved, rejections };
}

// ═══════════════════════════════════════════════════════
// Orchestrator
// ═══════════════════════════════════════════════════════

export interface OrchestratorOptions {
  backend: WorkspaceBackend;
  scanner: ScannerProvider;
  config: Partial<WorkspaceConfig>;
  agentId: string;
}

/**
 * Create a WorkspaceProvider by composing a backend with shared orchestration.
 *
 * The orchestrator:
 * - Tracks active scopes per session
 * - Delegates filesystem ops to the backend
 * - Applies structural checks + content scanning before persistence
 */
export function createOrchestrator(opts: OrchestratorOptions): WorkspaceProvider {
  const { backend, scanner } = opts;
  const agentId = opts.agentId;

  const maxFileSize = opts.config.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = opts.config.maxFiles ?? DEFAULT_MAX_FILES;
  const maxCommitSize = opts.config.maxCommitSize ?? DEFAULT_MAX_COMMIT_SIZE;
  const ignorePatterns = opts.config.ignorePatterns ?? DEFAULT_IGNORE_PATTERNS;

  /** Active scopes per session. */
  const sessionScopes = new Map<string, Set<WorkspaceScope>>();

  /** Remembered userId per session — set during mount, used during commit. */
  const sessionUserIds = new Map<string, string>();

  return {
    async mount(sessionId: string, scopes: WorkspaceScope[], opts?: MountOptions): Promise<WorkspaceMounts> {
      let active = sessionScopes.get(sessionId);
      if (!active) {
        active = new Set();
        sessionScopes.set(sessionId, active);
      }

      // Remember the userId so commit() can resolve the 'user' scope correctly.
      if (opts?.userId) {
        sessionUserIds.set(sessionId, opts.userId);
      }

      const ctx: ScopeContext = { sessionId, agentId, userId: opts?.userId };
      const paths: Partial<Record<WorkspaceScope, string>> = {};

      for (const scope of scopes) {
        if (!active.has(scope)) {
          const id = scopeId(scope, ctx);
          const mountPath = await backend.mount(scope, id);
          paths[scope] = mountPath;
          active.add(scope);
        }
      }

      return { paths };
    },

    async commit(sessionId: string): Promise<CommitResult> {
      const active = sessionScopes.get(sessionId);
      if (!active || active.size === 0) {
        return { scopes: {} };
      }

      const ctx: ScopeContext = { sessionId, agentId, userId: sessionUserIds.get(sessionId) };
      const scopes: Partial<Record<WorkspaceScope, ScopeCommitResult>> = {};

      for (const scope of active) {
        const id = scopeId(scope, ctx);
        const changes = await backend.diff(scope, id);

        if (changes.length === 0) {
          scopes[scope] = { status: 'empty', filesChanged: 0, bytesChanged: 0 };
          continue;
        }

        // Layer 1: Structural checks
        const { approved: structApproved, rejections: structRejections } = structuralFilter(
          changes,
          { maxFileSize, maxFiles, maxCommitSize, ignorePatterns },
        );

        // Layer 2: Content scanning (via ScannerProvider)
        const scanApproved: FileChange[] = [];
        const scanRejections: FileRejection[] = [];

        for (const change of structApproved) {
          // Deletes and files without content skip scanning
          if (change.type === 'deleted' || !change.content) {
            scanApproved.push(change);
            continue;
          }

          const result = await scanner.scanOutput({
            content: change.content.toString('utf-8'),
            source: `workspace:${scope}:${change.path}`,
            sessionId,
          });

          if (result.verdict === 'BLOCK') {
            scanRejections.push({
              path: change.path,
              reason: `scanner blocked: ${result.reason ?? 'content flagged'}`,
            });
          } else {
            scanApproved.push(change);
          }
        }

        const allRejections = [...structRejections, ...scanRejections];

        if (scanApproved.length === 0) {
          scopes[scope] = {
            status: allRejections.length > 0 ? 'rejected' : 'empty',
            filesChanged: 0,
            bytesChanged: 0,
            rejections: allRejections.length > 0 ? allRejections : undefined,
          };
          continue;
        }

        // Persist approved changes
        await backend.commit(scope, id, scanApproved);

        const bytesChanged = scanApproved.reduce((sum, c) => sum + c.size, 0);

        scopes[scope] = {
          status: 'committed',
          filesChanged: scanApproved.length,
          bytesChanged,
          rejections: allRejections.length > 0 ? allRejections : undefined,
        };
      }

      return { scopes };
    },

    async cleanup(sessionId: string): Promise<void> {
      sessionScopes.delete(sessionId);
      sessionUserIds.delete(sessionId);
    },

    activeMounts(sessionId: string): WorkspaceScope[] {
      const active = sessionScopes.get(sessionId);
      return active ? [...active] : [];
    },
  };
}
