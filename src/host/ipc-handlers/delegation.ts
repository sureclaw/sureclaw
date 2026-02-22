/**
 * IPC handler: agent delegation with depth/concurrency limits.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext, DelegationConfig, IPCHandlerOptions } from '../ipc-server.js';

export function createDelegationHandlers(providers: ProviderRegistry, opts?: IPCHandlerOptions) {
  const maxConcurrent = opts?.delegation?.maxConcurrent ?? 3;
  const maxDepth = opts?.delegation?.maxDepth ?? 2;
  let activeDelegations = 0;

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

      // Increment BEFORE any await to prevent race with concurrent calls
      activeDelegations++;
      try {
        await providers.audit.log({
          action: 'agent_delegate',
          sessionId: ctx.sessionId,
          args: { task: req.task.slice(0, 500), depth: currentDepth + 1 },
        });

        const childCtx: IPCContext = {
          sessionId: ctx.sessionId,
          agentId: `delegate-${ctx.agentId}:depth=${currentDepth + 1}`,
        };
        const response = await opts.onDelegate(req.task, req.context, childCtx);
        return { response };
      } finally {
        activeDelegations--;
      }
    },
  };
}
