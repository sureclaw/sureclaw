/**
 * IPC handlers: enterprise workspace operations (workspace_write, workspace_read, workspace_list).
 *
 * Three-tier workspace model:
 * - agent: shared agent workspace (read-only in sandbox, write via host IPC)
 * - user:  per-user workspace (read-write)
 * - scratch: ephemeral per-session (read-write)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { agentWorkspaceDir, userWorkspaceDir, scratchDir } from '../../paths.js';
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
      case 'scratch':
        return scratchDir(ctx.sessionId);
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

      await providers.audit.log({
        action: 'workspace_write',
        sessionId: ctx.sessionId,
        args: { tier: req.tier, path: req.path, bytes: req.content.length },
      });

      return { written: true, tier: req.tier, path: req.path };
    },

    workspace_read: async (req: any, ctx: IPCContext) => {
      const tierDir = resolveTierDir(req.tier, ctx);
      if (!existsSync(tierDir)) {
        return { ok: false, error: `Workspace tier "${req.tier}" not initialized` };
      }
      const filePath = safePathFromRelative(tierDir, req.path);
      try {
        const content = readFileSync(filePath, 'utf-8');
        return { content, tier: req.tier, path: req.path };
      } catch {
        return { ok: false, error: `File not found: ${req.path}` };
      }
    },

    workspace_list: async (req: any, ctx: IPCContext) => {
      const tierDir = resolveTierDir(req.tier, ctx);
      const subDir = req.path ? safePathFromRelative(tierDir, req.path) : tierDir;
      if (!existsSync(subDir)) {
        return { files: [] };
      }
      try {
        const entries = readdirSync(subDir, { withFileTypes: true });
        const files = entries.map((e: any) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
        }));
        return { files, tier: req.tier, path: req.path ?? '.' };
      } catch {
        return { files: [] };
      }
    },
  };
}
