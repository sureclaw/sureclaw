/**
 * IPC handlers: sandbox tool operations (sandbox_bash, sandbox_read_file,
 * sandbox_write_file, sandbox_edit_file).
 *
 * Normalizes each IPC action into a shared request shape, routes through
 * the intent router, and dispatches to the appropriate executor (local,
 * NATS, or eventually WASM).
 *
 * Every file operation uses safePath() for path containment (SC-SEC-004).
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { NATSSandboxDispatcher } from '../nats-sandbox-dispatch.js';
import { getLogger } from '../../logger.js';
import { createLocalExecutor } from '../sandbox-tools/local-executor.js';
import { createNATSExecutor } from '../sandbox-tools/nats-executor.js';
import { createWasmExecutor, HostcallError } from '../sandbox-tools/wasm-executor.js';
import { routeToolCall } from '../sandbox-tools/router.js';
import type { RouterConfig } from '../sandbox-tools/router.js';
import type {
  SandboxToolExecutor,
  SandboxToolRequest,
  SandboxToolResponse,
  SandboxExecutionContext,
} from '../sandbox-tools/types.js';

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

  /**
   * WASM/router configuration. When omitted, defaults to shadow mode
   * (everything routes to Tier 2 but logs would-have-been-tier-1 decisions).
   */
  routerConfig?: Partial<RouterConfig>;
}

function resolveWorkspace(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  const workspace = opts.workspaceMap.get(ctx.sessionId);
  if (!workspace) {
    throw new Error(`No workspace registered for session "${ctx.sessionId}"`);
  }
  return workspace;
}

function resolveRequestId(opts: SandboxToolHandlerOptions, ctx: IPCContext): string {
  return opts.requestIdMap?.get(ctx.sessionId) ?? ctx.sessionId;
}

/**
 * Build execution context from IPC context and options.
 */
function buildExecContext(opts: SandboxToolHandlerOptions, ctx: IPCContext): SandboxExecutionContext {
  return {
    workspace: resolveWorkspace(opts, ctx),
    sessionId: ctx.sessionId,
    requestId: resolveRequestId(opts, ctx),
  };
}

/**
 * Execute a tool request through the executor and emit audit events.
 */
async function executeAndAudit(
  executor: SandboxToolExecutor,
  request: SandboxToolRequest,
  execContext: SandboxExecutionContext,
  action: string,
  providers: ProviderRegistry,
  auditArgs: Record<string, unknown>,
): Promise<SandboxToolResponse> {
  try {
    const response = await executor.execute(request, execContext);

    const hasError = 'error' in response && response.error;
    await providers.audit.log({
      action,
      sessionId: execContext.sessionId,
      args: { ...auditArgs, executor: executor.name },
      result: hasError ? 'error' : 'success',
    });

    return response;
  } catch (err: unknown) {
    await providers.audit.log({
      action,
      sessionId: execContext.sessionId,
      args: { ...auditArgs, executor: executor.name },
      result: 'error',
    });
    throw err;
  }
}

/**
 * Map a normalized SandboxToolResponse back to the IPC response shape
 * expected by the agent for each action.
 */
function toIPCResponse(response: SandboxToolResponse): Record<string, unknown> {
  switch (response.type) {
    case 'bash':
      return { output: response.output };
    case 'read_file':
      if (response.error) return { error: response.error };
      return { content: response.content };
    case 'write_file':
      if (response.error) return { error: response.error };
      return { written: response.written, path: response.path };
    case 'edit_file':
      if (response.error) return { error: response.error };
      return { edited: response.edited, path: response.path };
  }
}

export function createSandboxToolHandlers(providers: ProviderRegistry, opts: SandboxToolHandlerOptions) {
  // Build executors
  const localExecutor = createLocalExecutor();
  const wasmExecutor = createWasmExecutor();
  const natsExecutor = opts.natsDispatcher
    ? createNATSExecutor(opts.natsDispatcher)
    : undefined;

  // Router config: default to shadow mode (Tier 2 for everything, log Tier 1 candidates)
  const routerConfig: RouterConfig = {
    wasmEnabled: opts.routerConfig?.wasmEnabled ?? false,
    shadowMode: opts.routerConfig?.shadowMode ?? true,
    compareMode: opts.routerConfig?.compareMode ?? false,
  };

  // Select the default Tier 2 executor based on deployment mode
  const defaultExecutor = natsExecutor ?? localExecutor;

  /**
   * Core dispatch: normalize request → route → execute → audit → respond.
   *
   * Fallback semantics:
   * - If Tier 1 throws a HostcallError (deterministic policy failure), fail closed.
   *   These are security policy violations and must NOT be retried via Tier 2.
   * - If Tier 1 throws any other error (runtime failure), retry via Tier 2.
   *   This preserves correctness at the cost of latency.
   */
  async function dispatch(
    action: string,
    request: SandboxToolRequest,
    ctx: IPCContext,
    auditArgs: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const route = routeToolCall(request, routerConfig);

    logger.debug('tool_dispatch', {
      action,
      tier: route.tier,
      executor: route.executor,
      reason: route.reason,
      sessionId: ctx.sessionId,
    });

    const execContext = buildExecContext(opts, ctx);

    // Tier 2: direct execution, no fallback
    if (route.tier === 2) {
      const response = await executeAndAudit(
        defaultExecutor,
        request,
        execContext,
        action,
        providers,
        { ...auditArgs, tier: 2, routeReason: route.reason },
      );
      return toIPCResponse(response);
    }

    // Compare mode: run both tiers in parallel, serve Tier 2, log mismatches.
    // Only active when wasmEnabled=true and shadowMode=false.
    if (routerConfig.compareMode) {
      const [wasmResult, defaultResult] = await Promise.allSettled([
        executeAndAudit(wasmExecutor, request, execContext, action, providers, {
          ...auditArgs, tier: 1, routeReason: route.reason, compareMode: true,
        }),
        executeAndAudit(defaultExecutor, request, execContext, action, providers, {
          ...auditArgs, tier: 2, routeReason: 'compare mode baseline', compareMode: true,
        }),
      ]);

      // Log comparison results
      const wasmOk = wasmResult.status === 'fulfilled';
      const defaultOk = defaultResult.status === 'fulfilled';

      if (wasmOk && defaultOk) {
        const wasmResp = toIPCResponse(wasmResult.value);
        const defaultResp = toIPCResponse(defaultResult.value);
        const match = JSON.stringify(wasmResp) === JSON.stringify(defaultResp);

        if (!match) {
          logger.warn('compare_mismatch', {
            action,
            sessionId: ctx.sessionId,
            wasmResponse: wasmResp,
            defaultResponse: defaultResp,
          });
        }

        await providers.audit.log({
          action,
          sessionId: execContext.sessionId,
          args: { ...auditArgs, compareMode: true, match, wasmOk, defaultOk },
          result: match ? 'compare_match' : 'compare_mismatch',
        });

        return defaultResp;
      }

      // One or both failed — log and serve whichever succeeded (prefer Tier 2)
      const wasmErr = !wasmOk ? (wasmResult as PromiseRejectedResult).reason : undefined;
      const defaultErr = !defaultOk ? (defaultResult as PromiseRejectedResult).reason : undefined;

      logger.warn('compare_error', {
        action,
        sessionId: ctx.sessionId,
        wasmOk,
        defaultOk,
        wasmError: wasmErr instanceof Error ? wasmErr.message : String(wasmErr ?? ''),
        defaultError: defaultErr instanceof Error ? defaultErr.message : String(defaultErr ?? ''),
      });

      await providers.audit.log({
        action,
        sessionId: execContext.sessionId,
        args: {
          ...auditArgs,
          compareMode: true,
          wasmOk,
          defaultOk,
          wasmError: wasmErr instanceof Error ? wasmErr.message : undefined,
          defaultError: defaultErr instanceof Error ? defaultErr.message : undefined,
        },
        result: 'compare_error',
      });

      // Serve Tier 2 if it succeeded, otherwise throw the Tier 2 error
      if (defaultOk) {
        return toIPCResponse(defaultResult.value);
      }
      throw defaultErr;
    }

    // Tier 1: execute with fallback-to-Tier-2 on runtime errors
    try {
      const response = await executeAndAudit(
        wasmExecutor,
        request,
        execContext,
        action,
        providers,
        { ...auditArgs, tier: 1, routeReason: route.reason },
      );
      return toIPCResponse(response);
    } catch (err: unknown) {
      // Deterministic policy failures fail closed — never fall back
      if (err instanceof HostcallError) {
        throw err;
      }

      // Runtime error: fall back to Tier 2
      logger.warn('tier1_fallback', {
        action,
        sessionId: ctx.sessionId,
        error: (err as Error).message,
        reason: 'runtime error in Tier 1, retrying via Tier 2',
      });

      await providers.audit.log({
        action,
        sessionId: execContext.sessionId,
        args: { ...auditArgs, tier: 1, fallback: true, error: (err as Error).message },
        result: 'fallback',
      });

      const response = await executeAndAudit(
        defaultExecutor,
        request,
        execContext,
        action,
        providers,
        { ...auditArgs, tier: 2, routeReason: 'fallback from Tier 1 runtime error' },
      );
      return toIPCResponse(response);
    }
  }

  return {
    sandbox_bash: async (req: any, ctx: IPCContext) => {
      const request: SandboxToolRequest = {
        type: 'bash',
        command: req.command,
        timeoutMs: 30_000,
      };
      return dispatch('sandbox_bash', request, ctx, {
        command: req.command.slice(0, 200),
      });
    },

    sandbox_read_file: async (req: any, ctx: IPCContext) => {
      const request: SandboxToolRequest = {
        type: 'read_file',
        path: req.path,
      };
      return dispatch('sandbox_read_file', request, ctx, {
        path: req.path,
      });
    },

    sandbox_write_file: async (req: any, ctx: IPCContext) => {
      const request: SandboxToolRequest = {
        type: 'write_file',
        path: req.path,
        content: req.content,
      };
      return dispatch('sandbox_write_file', request, ctx, {
        path: req.path,
        bytes: req.content.length,
      });
    },

    sandbox_edit_file: async (req: any, ctx: IPCContext) => {
      const request: SandboxToolRequest = {
        type: 'edit_file',
        path: req.path,
        old_string: req.old_string,
        new_string: req.new_string,
      };
      return dispatch('sandbox_edit_file', request, ctx, {
        path: req.path,
      });
    },
  };
}
