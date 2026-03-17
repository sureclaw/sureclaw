// src/providers/workspace/shared.ts — Shared orchestration logic
//
// Core commit pipeline used by real workspace backends (local, gcs, etc.).
// Handles scope tracking and delegates to backend for persistence.

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
} from './types.js';

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
 * - Passes all changes from diff() directly to backend.commit()
 *
 * NOTE: Structural checks and content scanning are bypassed. The sandbox
 * isolation model (no network, no credentials) makes output scanning
 * low-value, and the structural filter adds latency to the commit pipeline.
 * Re-enable when cost/benefit warrants it.
 */
export function createOrchestrator(opts: OrchestratorOptions): WorkspaceProvider {
  const { backend } = opts;
  const agentId = opts.agentId;

  /** Active scopes per session. */
  const sessionScopes = new Map<string, Set<WorkspaceScope>>();

  /** Remembered userId per session — set during mount, used during commit. */
  const sessionUserIds = new Map<string, string>();

  /** Remembered mount paths — "sessionId:scope" → path, so repeated mounts return the path. */
  const scopePaths = new Map<string, string>();

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
          // Remember the path so we can return it on subsequent mount calls
          scopePaths.set(`${sessionId}:${scope}`, mountPath);
        } else {
          // Already mounted — return the remembered path so callers can use it
          const remembered = scopePaths.get(`${sessionId}:${scope}`);
          if (remembered) paths[scope] = remembered;
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

        // Persist all changes directly — no filtering or scanning.
        await backend.commit(scope, id, changes);

        const bytesChanged = changes.reduce((sum, c) => sum + c.size, 0);

        scopes[scope] = {
          status: 'committed',
          filesChanged: changes.length,
          bytesChanged,
        };
      }

      return { scopes };
    },

    async cleanup(sessionId: string): Promise<void> {
      sessionScopes.delete(sessionId);
      sessionUserIds.delete(sessionId);
      // Clean up remembered paths for this session
      for (const key of scopePaths.keys()) {
        if (key.startsWith(`${sessionId}:`)) scopePaths.delete(key);
      }
    },

    activeMounts(sessionId: string): WorkspaceScope[] {
      const active = sessionScopes.get(sessionId);
      return active ? [...active] : [];
    },
  };
}
