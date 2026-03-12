/**
 * IPC handlers: enterprise workspace write operations (workspace_write, workspace_write_file).
 *
 * Two-tier workspace model:
 * - agent: shared agent workspace (read-only in sandbox, write via host IPC)
 * - user:  per-user persistent workspace (read-write)
 *
 * Read/list operations are handled directly by local tools in the sandbox
 * since tiers are mounted/symlinked into the agent's filesystem.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { agentWorkspaceDir, userWorkspaceDir } from '../../paths.js';
import { safePath } from '../../utils/safe-path.js';

/** Split a relative path and pass each segment through safePath for traversal protection. */
function safePathFromRelative(baseDir: string, relativePath: string): string {
  // Split on forward and backslash, filter empty segments
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  return safePath(baseDir, ...segments);
}

export interface WorkspaceHandlerOptions {
  agentName: string;
  profile: string;
}

export function createWorkspaceHandlers(providers: ProviderRegistry, opts: WorkspaceHandlerOptions) {
  const { agentName, profile } = opts;

  function resolveTierDir(tier: string, ctx: IPCContext): string {
    switch (tier) {
      case 'agent':
        return agentWorkspaceDir(agentName);
      case 'user':
        return userWorkspaceDir(agentName, ctx.userId ?? 'default');
      default:
        throw new Error(`Unknown workspace tier: ${tier}`);
    }
  }

  return {
    workspace_write: async (req: any, ctx: IPCContext) => {
      const tierDir = resolveTierDir(req.tier, ctx);
      mkdirSync(tierDir, { recursive: true });
      const filePath = safePathFromRelative(tierDir, req.path);

      // Agent workspace writes require approval in paranoid mode
      if (req.tier === 'agent' && profile === 'paranoid') {
        await providers.audit.log({
          action: 'workspace_write',
          sessionId: ctx.sessionId,
          args: { tier: req.tier, path: req.path, decision: 'queued_paranoid' },
        });
        return { queued: true, reason: 'Agent workspace writes require approval in paranoid mode' };
      }

      // Scan content for injection
      const scanResult = await providers.scanner.scanInput({
        content: req.content,
        source: 'workspace_write',
        sessionId: ctx.sessionId,
      });
      if (scanResult.verdict === 'BLOCK') {
        return { ok: false, error: `Content blocked by scanner: ${scanResult.reason ?? 'policy violation'}` };
      }

      // Ensure parent directory exists
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, req.content, 'utf-8');

      // Fire-and-forget sync to remote backing store
      if (providers.workspaceSync) {
        const remotePrefix = req.tier === 'agent'
          ? `workspaces/${agentName}/agent/`
          : `workspaces/${agentName}/users/${ctx.userId ?? 'default'}/`;
        void providers.workspaceSync
          .uploadFile(tierDir, remotePrefix, req.path)
          .catch(() => {}); // Errors logged inside provider
      }

      await providers.audit.log({
        action: 'workspace_write',
        sessionId: ctx.sessionId,
        args: { tier: req.tier, path: req.path, bytes: req.content.length },
      });

      return { written: true, tier: req.tier, path: req.path };
    },

    workspace_write_file: async (req: any, ctx: IPCContext) => {
      const tierDir = resolveTierDir(req.tier, ctx);
      mkdirSync(tierDir, { recursive: true });
      const filePath = safePathFromRelative(tierDir, req.path);

      // Agent workspace writes require approval in paranoid mode
      if (req.tier === 'agent' && profile === 'paranoid') {
        await providers.audit.log({
          action: 'workspace_write_file',
          sessionId: ctx.sessionId,
          args: { tier: req.tier, path: req.path, decision: 'queued_paranoid' },
        });
        return { queued: true, reason: 'Agent workspace writes require approval in paranoid mode' };
      }

      // Decode base64 data
      const data = Buffer.from(req.data, 'base64');
      if (data.length === 0) {
        return { ok: false, error: 'Empty file data' };
      }

      // Ensure parent directory exists
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, data);

      // Fire-and-forget sync to remote backing store
      if (providers.workspaceSync) {
        const remotePrefix = req.tier === 'agent'
          ? `workspaces/${agentName}/agent/`
          : `workspaces/${agentName}/users/${ctx.userId ?? 'default'}/`;
        void providers.workspaceSync
          .uploadFile(tierDir, remotePrefix, req.path)
          .catch(() => {}); // Errors logged inside provider
      }

      await providers.audit.log({
        action: 'workspace_write_file',
        sessionId: ctx.sessionId,
        args: { tier: req.tier, path: req.path, bytes: data.length, mimeType: req.mimeType },
      });

      return { written: true, tier: req.tier, path: req.path, size: data.length };
    },

  };
}
