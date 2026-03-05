/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file).
 *
 * In local mode these execute directly on the host filesystem using the
 * session's workspace directory. In k8s mode, they dispatch to sandbox
 * pods via NATS request/reply using the NATSSandboxDispatcher.
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { safePath } from '../../utils/safe-path.js';
import type { NATSSandboxDispatcher } from '../nats-sandbox-dispatch.js';
import type { SandboxToolRequest } from '../../sandbox-worker/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'sandbox-tools' });

export interface SandboxToolHandlerOptions {
  /**
   * Maps sessionId to the workspace directory for that session.
   * Populated by processCompletion() before the agent is spawned,
   * cleaned up after the agent finishes.
   */
  workspaceMap: Map<string, string>;

  /**
   * When set, tool calls dispatch via NATS to remote sandbox pods
   * instead of executing locally. Used when sandbox provider is k8s.
   */
  natsDispatcher?: NATSSandboxDispatcher;

  /**
   * Maps sessionId to requestId for per-turn pod affinity.
   * The dispatcher uses requestId to track which pod to reuse.
   */
  requestIdMap?: Map<string, string>;
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

/**
 * Get the requestId for a given session, used for per-turn pod affinity.
 */
function resolveRequestId(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  return opts.requestIdMap?.get(ctx.sessionId) ?? ctx.sessionId;
}

/**
 * Dispatch a tool call via NATS to a remote sandbox pod.
 * Returns the tool response, or throws on timeout/error.
 */
async function dispatchViaNATS(
  dispatcher: NATSSandboxDispatcher,
  requestId: string,
  sessionId: string,
  tool: SandboxToolRequest,
  action: string,
  providers: ProviderRegistry,
): Promise<any> {
  try {
    logger.info('nats_dispatch_start', { requestId, toolType: tool.type, action });
    const result = await dispatcher.dispatch(requestId, sessionId, tool);
    logger.info('nats_dispatch_success', { requestId, toolType: tool.type });
    await providers.audit.log({
      action,
      sessionId,
      args: { dispatchMode: 'nats', toolType: tool.type },
      result: 'success',
    });
    return result;
  } catch (err: unknown) {
    logger.error('nats_dispatch_error', { requestId, toolType: tool.type, error: (err as Error).message });
    await providers.audit.log({
      action,
      sessionId,
      args: { dispatchMode: 'nats', toolType: tool.type },
      result: 'error',
    });
    return { error: `NATS dispatch error: ${(err as Error).message}` };
  }
}

export function createSandboxToolHandlers(providers: ProviderRegistry, opts: SandboxToolHandlerOptions) {
  const { natsDispatcher } = opts;

  return {
    sandbox_bash: async (req: any, ctx: IPCContext) => {
      // NATS dispatch mode
      if (natsDispatcher) {
        const requestId = resolveRequestId(opts, ctx);
        const tool: SandboxToolRequest = {
          type: 'bash',
          command: req.command,
          timeoutMs: 30_000,
        };
        const result = await dispatchViaNATS(natsDispatcher, requestId, ctx.sessionId, tool, 'sandbox_bash', providers);
        // Normalize response shape to match local mode
        if ('output' in result) return { output: result.output };
        if ('error' in result) return { output: result.error };
        return result;
      }

      // Local execution mode
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
      if (natsDispatcher) {
        const requestId = resolveRequestId(opts, ctx);
        const tool: SandboxToolRequest = { type: 'read_file', path: req.path };
        const result = await dispatchViaNATS(natsDispatcher, requestId, ctx.sessionId, tool, 'sandbox_read_file', providers);
        // Normalize: read_file_result has content/error
        if ('content' in result) return { content: result.content };
        if ('error' in result) return { error: result.error };
        return result;
      }

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
      if (natsDispatcher) {
        const requestId = resolveRequestId(opts, ctx);
        const tool: SandboxToolRequest = { type: 'write_file', path: req.path, content: req.content };
        const result = await dispatchViaNATS(natsDispatcher, requestId, ctx.sessionId, tool, 'sandbox_write_file', providers);
        if ('written' in result) return { written: result.written, path: result.path };
        if ('error' in result) return { error: result.error };
        return result;
      }

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
      if (natsDispatcher) {
        const requestId = resolveRequestId(opts, ctx);
        const tool: SandboxToolRequest = {
          type: 'edit_file',
          path: req.path,
          old_string: req.old_string,
          new_string: req.new_string,
        };
        const result = await dispatchViaNATS(natsDispatcher, requestId, ctx.sessionId, tool, 'sandbox_edit_file', providers);
        if ('edited' in result) return { edited: result.edited, path: result.path };
        if ('error' in result) return { error: result.error };
        return result;
      }

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
  };
}
