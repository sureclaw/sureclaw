/**
 * IPC handler: agent delegation with depth/concurrency limits and wait queue.
 *
 * When all delegation slots are occupied, requests wait in a FIFO queue
 * (up to queue_timeout_ms) instead of being immediately rejected.
 * This handles bursty delegation patterns where slots free up quickly.
 */
import type { ProviderRegistry, AgentType } from '../../types.js';
import type { IPCContext, DelegationConfig, IPCHandlerOptions, DelegateRequest } from '../ipc-server.js';

/** Maximum waiters in the delegation queue before immediate rejection. */
const MAX_DELEGATION_WAITERS = 20;

interface DelegationWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  enqueuedAt: number;
}

export function createDelegationHandlers(providers: ProviderRegistry, opts?: IPCHandlerOptions) {
  const maxConcurrent = opts?.delegation?.maxConcurrent ?? 3;
  const maxDepth = opts?.delegation?.maxDepth ?? 2;
  const queueTimeoutMs = opts?.delegation?.queueTimeoutMs ?? 0; // 0 = no queue (legacy behavior)
  let activeDelegations = 0;
  const waiters: DelegationWaiter[] = [];

  /** Release a slot and wake the next waiter if any. */
  function releaseSlot(): void {
    if (waiters.length > 0) {
      const next = waiters.shift()!;
      // Don't decrement active — the slot transfers to the next waiter
      next.resolve();
    } else {
      activeDelegations--;
    }
  }

  /** Wait for a delegation slot with timeout. */
  function waitForSlot(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const waiter: DelegationWaiter = { resolve, reject, enqueuedAt: Date.now() };
      waiters.push(waiter);

      // Timeout: if no slot opens in time, reject
      const timeoutId = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) {
          waiters.splice(idx, 1);
          reject(new Error(`Delegation queue timeout after ${queueTimeoutMs}ms`));
        }
      }, queueTimeoutMs);

      // Override resolve to clear the timeout
      const origResolve = waiter.resolve;
      waiter.resolve = () => {
        clearTimeout(timeoutId);
        origResolve();
      };

      // Override reject to clear the timeout
      const origReject = waiter.reject;
      waiter.reject = (err: Error) => {
        clearTimeout(timeoutId);
        origReject(err);
      };
    });
  }

  return {
    agent_delegate: async (req: any, ctx: IPCContext) => {
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

      // Enforce concurrency limit — with optional wait queue
      if (activeDelegations >= maxConcurrent) {
        if (queueTimeoutMs <= 0 || waiters.length >= MAX_DELEGATION_WAITERS) {
          return {
            ok: false,
            error: `Max concurrent delegations reached (${maxConcurrent})`,
          };
        }

        // Wait for a slot (with timeout)
        try {
          await waitForSlot();
        } catch (err) {
          return {
            ok: false,
            error: err instanceof Error ? err.message : 'Delegation queue timeout',
          };
        }
      } else {
        // Slot available — claim it immediately
        activeDelegations++;
      }

      // At this point we own a slot (either claimed directly or transferred from releaseSlot)
      try {
        await providers.audit.log({
          action: 'agent_delegate',
          sessionId: ctx.sessionId,
          args: {
            task: req.task.slice(0, 500),
            depth: currentDepth + 1,
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
        };
        const response = await opts.onDelegate(delegateReq, childCtx);
        return { response };
      } catch (err) {
        return {
          ok: false,
          error: `Delegation failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      } finally {
        releaseSlot();
      }
    },
  };
}
