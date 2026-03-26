/**
 * IPC handlers: workspace provider operations.
 *
 * Workspace provider model (workspace_mount):
 * - agent:   shared persistent workspace
 * - user:    per-user persistent workspace
 * - session: temporary scratch for the current session
 *
 * All writes go through the workspace provider's mount/diff/commit pipeline,
 * which enforces structural checks and content scanning before persistence.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { WorkspaceScope } from '../../providers/workspace/types.js';
import { safePath } from '../../utils/safe-path.js';

export interface WorkspaceHandlerOptions {
  agentName: string;
  profile: string;
}

export function createWorkspaceHandlers(providers: ProviderRegistry, opts: WorkspaceHandlerOptions) {
  return {
    workspace_mount: async (req: any, ctx: IPCContext) => {
      const requestedScopes = req.scopes as WorkspaceScope[];

      // Determine which scopes are not yet active
      const currentScopes = providers.workspace.activeMounts(ctx.sessionId);
      const newScopes = requestedScopes.filter(s => !currentScopes.includes(s));

      if (newScopes.length === 0) {
        // All requested scopes already active — return current state
        return {
          mounted: currentScopes,
          paths: {},
        };
      }

      // Mount new scopes (additive), passing userId for user scope resolution
      const mounts = await providers.workspace.mount(ctx.sessionId, newScopes, { userId: ctx.userId });

      await providers.audit.log({
        action: 'workspace_mount',
        sessionId: ctx.sessionId,
        args: { scopes: newScopes, allScopes: [...currentScopes, ...newScopes] },
      });

      return {
        mounted: [...currentScopes, ...newScopes],
        paths: mounts.paths,
      };
    },

    workspace_write: async (req: any, ctx: IPCContext) => {
      const tier = req.tier as WorkspaceScope;

      // Auto-mount the tier (returns existing paths if already mounted)
      const mounts = await providers.workspace.mount(ctx.sessionId, [tier], { userId: ctx.userId });
      const tierPath = mounts.paths[tier];

      if (!tierPath) {
        return { ok: false, error: `Failed to resolve workspace tier "${tier}"` };
      }

      // Write the file using safePath for traversal protection.
      // safePath treats its arguments as individual path segments, not relative paths —
      // split the path first so each component is sanitized independently.
      const segments = req.path.split(/[/\\]/).filter(Boolean);
      const filePath = safePath(tierPath, ...segments);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, req.content, 'utf-8');

      await providers.audit.log({
        action: 'workspace_write',
        sessionId: ctx.sessionId,
        args: { tier, path: req.path, bytes: req.content.length },
        result: 'success',
      });

      return { written: true, tier, path: req.path };
    },

    workspace_list: async (req: any, ctx: IPCContext) => {
      if (!providers.workspace?.listFiles) {
        return { ok: false, error: 'Workspace provider does not support listing' };
      }
      const scope = req.scope as WorkspaceScope;
      const id = scope === 'session' ? ctx.sessionId
        : scope === 'user' ? (ctx.userId ?? ctx.sessionId)
        : opts.agentName;
      const files = await providers.workspace.listFiles(scope, id);

      const filtered = req.prefix
        ? files.filter((f: { path: string }) => f.path.startsWith(req.prefix))
        : files;

      return { ok: true, files: filtered.map((f: { path: string; size: number }) => ({ path: f.path, size: f.size })) };
    },

    workspace_read: async (req: any, ctx: IPCContext) => {
      if (!providers.workspace?.downloadScope) {
        return { ok: false, error: 'Workspace provider does not support reading' };
      }
      const scope = req.scope as WorkspaceScope;
      const id = scope === 'session' ? ctx.sessionId
        : scope === 'user' ? (ctx.userId ?? ctx.sessionId)
        : opts.agentName;
      const allFiles = await providers.workspace.downloadScope(scope, id);
      const file = allFiles.find((f: { path: string }) => f.path === req.path);
      if (!file) return { ok: false, error: `File not found: ${req.path}` };

      return {
        ok: true,
        path: file.path,
        content: file.content.toString('utf-8'),
        size: file.content.length,
      };
    },

  };
}
