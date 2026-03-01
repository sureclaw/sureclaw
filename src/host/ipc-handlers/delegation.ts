/**
 * IPC handler: agent delegation with depth/concurrency limits.
 *
 * Supports two modes via the `wait` parameter:
 * - `wait: true` (default) — blocks until the delegate completes, returns `{response}`
 * - `wait: false` — fire-and-forget, returns `{handleId, status: "started"}` immediately;
 *   the caller collects results via `agent_collect`.
 */
import { randomUUID } from 'node:crypto';
import type { ProviderRegistry, AgentType } from '../../types.js';
import type { IPCContext, DelegationConfig, IPCHandlerOptions, DelegateRequest } from '../ipc-server.js';
import type { AgentHandle } from '../orchestration/types.js';

/** Settled result for a fire-and-forget delegation. */
interface PendingDelegate {
  promise: Promise<{ response: string } | { error: string }>;
  /** Orchestrator handle (if available). */
  handle?: AgentHandle;
}

export function createDelegationHandlers(providers: ProviderRegistry, opts?: IPCHandlerOptions) {
  const maxConcurrent = opts?.delegation?.maxConcurrent ?? 3;
  const maxDepth = opts?.delegation?.maxDepth ?? 2;
  let activeDelegations = 0;

  /** In-flight fire-and-forget delegates, keyed by handleId. */
  const pending = new Map<string, PendingDelegate>();

  return {
    agent_delegate: async (req: any, ctx: IPCContext) => {
      // Enforce concurrency limit
      if (activeDelegations >= maxConcurrent) {
        return {
          ok: false,
          error: `Max concurrent delegations reached (${maxConcurrent})`,
        };
      }

      // Extract and check delegation depth from context
      const currentDepth = parseInt(ctx.agentId.split(':depth=')[1] ?? '0', 10);
      if (currentDepth >= maxDepth) {
        return {
          ok: false,
          error: `Max delegation depth reached (${maxDepth})`,
        };
      }

      if (!opts?.onDelegate) {
        return {
          ok: false,
          error: 'Delegation not configured on this host',
        };
      }

      // Increment BEFORE any await to prevent race with concurrent calls.
      // The try/finally ensures the counter is always decremented, even if
      // the handler throws — preventing the "zombie counter" bug where
      // activeDelegations stays inflated and blocks all future delegations.
      activeDelegations++;

      const fireAndForget = req.wait === false;

      try {
        await providers.audit.log({
          action: 'agent_delegate',
          sessionId: ctx.sessionId,
          args: {
            task: req.task.slice(0, 500),
            depth: currentDepth + 1,
            wait: req.wait ?? true,
            ...(req.runner ? { runner: req.runner } : {}),
            ...(req.model ? { model: req.model } : {}),
          },
        });

        const childCtx: IPCContext = {
          sessionId: ctx.sessionId,
          agentId: `delegate-${ctx.agentId}:depth=${currentDepth + 1}`,
        };
        const delegateReq: DelegateRequest = {
          task: req.task,
          context: req.context,
          runner: req.runner as AgentType | undefined,
          model: req.model,
          maxTokens: req.maxTokens,
          timeoutSec: req.timeoutSec,
          wait: req.wait,
        };

        if (fireAndForget) {
          // Register a handle in the orchestrator (if available) so the
          // caller can check status via agent_orch_status.
          const handleId = randomUUID();
          // Generate a child requestId that will be used both:
          // 1. As the handle's sessionId (so sessionToHandles maps correctly)
          // 2. As the child processCompletion's requestId (so child events match)
          const childRequestId = `delegate-${randomUUID().slice(0, 8)}`;
          const orchestrator = opts?.orchestrator;
          let handle: AgentHandle | undefined;
          if (orchestrator) {
            handle = orchestrator.register({
              agentId: childCtx.agentId,
              agentType: (req.runner as AgentType) ?? 'pi-coding-agent',
              parentId: null,
              sessionId: childRequestId,
              userId: ctx.userId ?? '',
              activity: `Delegated: ${req.task.slice(0, 100)}`,
              metadata: { handleId, task: req.task.slice(0, 500) },
            });
            // Transition from spawning → running immediately so that
            // completed/failed transitions are valid when the delegate finishes.
            orchestrator.supervisor.transition(handle.id, 'running', `Delegating: ${req.task.slice(0, 100)}`);
          }

          const effectiveHandleId = handle?.id ?? handleId;

          // Pass the child requestId so handleDelegate uses the same ID
          // that the orchestrator handle is registered with — this ensures
          // the child agent's events (llm.start, tool.call, etc.) align
          // with sessionToHandles and auto-state keeps the heartbeat alive.
          delegateReq.requestId = childRequestId;

          // Launch in background — store promise so agent_collect can await it
          const delegatePromise = opts.onDelegate(delegateReq, childCtx)
            .then((response): { response: string } => {
              if (handle) {
                handle.metadata.response = response;
                handle.metadata.completedAt = Date.now();
                orchestrator!.supervisor.transition(handle.id, 'completed', 'Delegation completed');
              }
              return { response };
            })
            .catch((err): { error: string } => {
              const errorMsg = err instanceof Error ? err.message : String(err);
              if (handle) {
                handle.metadata.error = errorMsg;
                handle.metadata.completedAt = Date.now();
                orchestrator!.supervisor.transition(handle.id, 'failed', `Delegation failed: ${errorMsg}`);
              }
              return { error: `Delegation failed: ${errorMsg}` };
            })
            .finally(() => {
              activeDelegations--;
            });

          pending.set(effectiveHandleId, { promise: delegatePromise, handle });

          return { handleId: effectiveHandleId, status: 'started' };
        }

        // Default blocking path (wait: true or omitted)
        const response = await opts.onDelegate(delegateReq, childCtx);
        return { response };
      } catch (err) {
        // Return a structured error instead of letting the exception propagate
        // to the IPC handler's generic catch. This ensures:
        // 1. The error response shape matches limit/depth rejections ({ok, error})
        // 2. The activeDelegations counter is decremented (via finally)
        // 3. The error message is specific to the delegation failure
        return {
          ok: false,
          error: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        // Only decrement in blocking path — fire-and-forget decrements in .finally() above
        if (!fireAndForget) {
          activeDelegations--;
        }
      }
    },

    /**
     * Collect results from fire-and-forget delegates.
     * Blocks until all requested handles have completed (or timeout).
     */
    agent_collect: async (req: any, _ctx: IPCContext) => {
      const handleIds: string[] = req.handleIds;
      const timeoutMs: number = req.timeoutMs ?? 300_000; // 5 min default

      // Validate all handles exist
      const unknown = handleIds.filter(id => !pending.has(id));
      if (unknown.length > 0) {
        return {
          ok: false,
          error: `Unknown handle IDs: ${unknown.join(', ')}`,
        };
      }

      // Race all pending promises against a timeout
      const promises = handleIds.map(async (id) => {
        const entry = pending.get(id)!;
        const result = await entry.promise;
        return { handleId: id, ...result };
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`agent_collect timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        const results = await Promise.race([
          Promise.all(promises),
          timeoutPromise,
        ]);

        // Clean up settled handles from the pending map
        for (const id of handleIds) {
          pending.delete(id);
        }

        return { results };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    },
  };
}
