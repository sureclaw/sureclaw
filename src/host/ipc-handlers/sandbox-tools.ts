/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file) and audit gate (sandbox_approve,
 * sandbox_result).
 *
 * In subprocess mode these execute directly on the host filesystem using the
 * session's workspace directory. In container mode (docker/apple/k8s), the
 * agent executes tools locally inside the container and uses the audit gate
 * for pre-execution approval and post-execution reporting.
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'sandbox-tools' });

export interface SandboxToolHandlerOptions {
  /**
   * Maps sessionId to the workspace directory for that session.
   * Populated by processCompletion() before the agent is spawned,
   * cleaned up after the agent finishes.
   */
  workspaceMap: Map<string, string>;
}

function resolveWorkspace(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  const workspace = opts.workspaceMap.get(ctx.sessionId);
  if (!workspace) {
    throw new Error(`No workspace registered for session "${ctx.sessionId}"`);
  }
  return workspace;
}

/**
 * Resolve a relative path within the workspace using safePath().
 * The path is split on forward/backslashes and each segment is passed
 * individually to safePath() for traversal protection.
 */
function safeWorkspacePath(workspace: string, relativePath: string): string {
  const segments = relativePath.split(/[/\\]/).filter(Boolean);
  return safePath(workspace, ...segments);
}

export function createSandboxToolHandlers(providers: ProviderRegistry, opts: SandboxToolHandlerOptions) {
  return {
    sandbox_bash: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        // nosemgrep: javascript.lang.security.detect-child-process — intentional: sandbox tool
        const out = execSync(req.command, {
          cwd: workspace,
          encoding: 'utf-8',
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        await providers.audit.log({
          action: 'sandbox_bash',
          sessionId: ctx.sessionId,
          args: { command: req.command.slice(0, 200) },
          result: 'success',
        });
        return { output: out };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; status?: number };
        const output = [e.stdout, e.stderr].filter(Boolean).join('\n') || 'Command failed';
        await providers.audit.log({
          action: 'sandbox_bash',
          sessionId: ctx.sessionId,
          args: { command: req.command.slice(0, 200) },
          result: 'error',
        });
        return { output: `Exit code ${e.status ?? 1}\n${output}` };
      }
    },

    sandbox_read_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { content };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_read_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error reading file: ${(err as Error).message}` };
      }
    },

    sandbox_write_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, req.content, 'utf-8');
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path, bytes: req.content.length },
          result: 'success',
        });
        return { written: true, path: req.path };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_write_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error writing file: ${(err as Error).message}` };
      }
    },

    sandbox_edit_file: async (req: any, ctx: IPCContext) => {
      const workspace = resolveWorkspace(opts, ctx);
      try {
        const abs = safeWorkspacePath(workspace, req.path);
        const content = readFileSync(abs, 'utf-8');
        if (!content.includes(req.old_string)) {
          return { error: 'old_string not found in file' };
        }
        writeFileSync(abs, content.replace(req.old_string, req.new_string), 'utf-8');
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'success',
        });
        return { edited: true, path: req.path };
      } catch (err: unknown) {
        await providers.audit.log({
          action: 'sandbox_edit_file',
          sessionId: ctx.sessionId,
          args: { path: req.path },
          result: 'error',
        });
        return { error: `Error editing file: ${(err as Error).message}` };
      }
    },

    // ── Sandbox Audit Gate (container-local execution) ──────────

    sandbox_approve: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          mode: 'container-local',
        },
        result: 'success',
      });
      logger.debug('sandbox_approve', {
        sessionId: ctx.sessionId,
        operation: req.operation,
        ...(req.command ? { command: req.command.slice(0, 100) } : {}),
        ...(req.path ? { path: req.path } : {}),
      });
      // Option A+ hook point: policy check, return {approved: false, reason: "..."}
      return { approved: true };
    },

    sandbox_result: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({
        action: `sandbox_${req.operation}_result`,
        sessionId: ctx.sessionId,
        args: {
          ...(req.command ? { command: req.command.slice(0, 200) } : {}),
          ...(req.path ? { path: req.path } : {}),
          ...(req.exitCode !== undefined ? { exitCode: req.exitCode } : {}),
          ...(req.success !== undefined ? { success: req.success } : {}),
          mode: 'container-local',
        },
        result: (req.exitCode === 0 || req.success) ? 'success' : 'error',
      });
      return { ok: true };
    },

    // ── Web Proxy Governance ──────────────────────────────

    web_proxy_approve: async (req: any, ctx: IPCContext) => {
      const { resolveApproval, preApproveDomain } = await import('../web-proxy-approvals.js');

      // Try session-scoped key first (per-session proxy in server-completions),
      // then global key (k8s shared proxy in host-process keyed as 'host-process').
      let found = resolveApproval(ctx.sessionId, req.domain, req.approved);
      if (!found) {
        found = resolveApproval('host-process', req.domain, req.approved);
      }

      // Pre-cache the decision for future requests so the proxy's onApprove
      // callback returns immediately. Cache in both scopes so it works
      // regardless of which proxy path handles the next request.
      if (req.approved) {
        preApproveDomain(ctx.sessionId, req.domain);
        preApproveDomain('host-process', req.domain);
      }

      await providers.audit.log({
        action: 'web_proxy_approve',
        sessionId: ctx.sessionId,
        args: { domain: req.domain, approved: req.approved },
        result: 'success',
      });
      logger.debug('web_proxy_approve', {
        sessionId: ctx.sessionId,
        domain: req.domain,
        approved: req.approved,
        found,
      });
      return { ok: true, found };
    },
  };
}
