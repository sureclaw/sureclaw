/**
 * IPC handlers: agent orchestration actions.
 *
 * These handlers let sandboxed agents query the orchestrator for
 * active agents, send messages to peers, poll their mailbox, and
 * interrupt child agents. All operations are scope-enforced — an
 * agent can only see/message agents within its session or parent tree.
 */

import type { Orchestrator } from '../orchestration/orchestrator.js';
import type { IPCContext } from '../ipc-server.js';
import { toSnapshot, TERMINAL_STATES } from '../orchestration/types.js';

export function createOrchestrationHandlers(orchestrator: Orchestrator) {
  /**
   * Resolve the caller's handle ID from IPCContext.
   * The agentId in IPCContext is the registry agent name (e.g. 'main'),
   * but we need the runtime handle ID. We find it by matching sessionId + agentId.
   */
  function resolveCallerHandle(ctx: IPCContext): string | null {
    const candidates = orchestrator.directory.bySession(ctx.sessionId);
    // Match by agentId within the session — must use AND, not OR,
    // since bySession already filters by session so the sessionId
    // predicate would always be true, returning the first candidate.
    const match = candidates.find(h => h.agentId === ctx.agentId && !TERMINAL_STATES.has(h.state));
    return match?.id ?? null;
  }

  return {
    /**
     * Get status of own handle or another agent's handle.
     * Scope: own session only.
     */
    agent_orch_status: async (req: any, ctx: IPCContext) => {
      if (req.handleId) {
        const handle = orchestrator.supervisor.get(req.handleId);
        if (!handle) {
          return { ok: false, error: 'Agent not found' };
        }
        // Scope check: must be in same session
        if (handle.sessionId !== ctx.sessionId) {
          return { ok: false, error: 'Access denied: agent not in your session' };
        }
        return { ok: true, agent: toSnapshot(handle) };
      }

      // Return own status
      const callerId = resolveCallerHandle(ctx);
      if (!callerId) {
        return { ok: false, error: 'Caller not found in orchestrator' };
      }
      const handle = orchestrator.supervisor.get(callerId);
      if (!handle) {
        return { ok: false, error: 'Caller handle not found' };
      }
      return { ok: true, agent: toSnapshot(handle) };
    },

    /**
     * List active agents matching filters.
     * Scope: filtered to caller's session unless admin.
     */
    agent_orch_list: async (req: any, ctx: IPCContext) => {
      // Enforce session scope: agents can only see their own session
      const filter = {
        ...req,
        sessionId: req.sessionId ?? ctx.sessionId,
      };

      // Non-admin agents cannot query other sessions
      if (filter.sessionId !== ctx.sessionId) {
        filter.sessionId = ctx.sessionId;
      }

      const results = orchestrator.query(filter);
      return { ok: true, agents: results, count: results.length };
    },

    /**
     * Get agent tree from a root.
     * Scope: root must be in caller's session.
     */
    agent_orch_tree: async (req: any, ctx: IPCContext) => {
      const root = orchestrator.supervisor.get(req.rootId);
      if (!root) {
        return { ok: false, error: 'Root agent not found' };
      }
      if (root.sessionId !== ctx.sessionId) {
        return { ok: false, error: 'Access denied: agent not in your session' };
      }

      const tree = orchestrator.tree(req.rootId);
      if (!tree) {
        return { ok: false, error: 'Could not build agent tree' };
      }

      // Serialize tree with snapshots
      function serializeTree(node: any): any {
        return {
          agent: toSnapshot(node.handle),
          children: node.children.map(serializeTree),
        };
      }

      return { ok: true, tree: serializeTree(tree) };
    },

    /**
     * Send a message to another agent.
     * Scope: recipient must be in caller's session.
     */
    agent_orch_message: async (req: any, ctx: IPCContext) => {
      const callerId = resolveCallerHandle(ctx);
      if (!callerId) {
        return { ok: false, error: 'Caller not found in orchestrator' };
      }

      // Scope check: recipient must be in same session
      const recipient = orchestrator.supervisor.get(req.to);
      if (!recipient) {
        return { ok: false, error: 'Recipient agent not found' };
      }
      if (recipient.sessionId !== ctx.sessionId) {
        return { ok: false, error: 'Access denied: recipient not in your session' };
      }
      if (TERMINAL_STATES.has(recipient.state)) {
        return { ok: false, error: `Recipient agent is in terminal state: ${recipient.state}` };
      }

      try {
        const msg = orchestrator.send(callerId, req.to, {
          type: req.type,
          payload: req.payload,
          correlationId: req.correlationId,
          policyTags: req.policyTags,
        });
        return { ok: true, messageId: msg.id };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },

    /**
     * Poll mailbox for incoming messages.
     */
    agent_orch_poll: async (req: any, ctx: IPCContext) => {
      const callerId = resolveCallerHandle(ctx);
      if (!callerId) {
        return { ok: true, messages: [] };
      }

      const messages = orchestrator.pollMessages(callerId, req.limit ?? 50);
      return {
        ok: true,
        messages: messages.map(m => ({
          id: m.id,
          from: m.from,
          to: m.to,
          type: m.type,
          payload: m.payload,
          timestamp: m.timestamp,
          correlationId: m.correlationId,
        })),
      };
    },

    /**
     * Interrupt a child agent.
     * Scope: caller must be parent of the target agent.
     */
    agent_orch_interrupt: async (req: any, ctx: IPCContext) => {
      const target = orchestrator.supervisor.get(req.handleId);
      if (!target) {
        return { ok: false, error: 'Target agent not found' };
      }

      // Scope check: must be in same session
      if (target.sessionId !== ctx.sessionId) {
        return { ok: false, error: 'Access denied: agent not in your session' };
      }

      // Only parent agents can interrupt children
      const callerId = resolveCallerHandle(ctx);
      if (callerId && target.parentId !== callerId) {
        return { ok: false, error: 'Access denied: you can only interrupt your child agents' };
      }

      orchestrator.supervisor.interrupt(req.handleId, req.reason);
      return { ok: true };
    },

  };
}
