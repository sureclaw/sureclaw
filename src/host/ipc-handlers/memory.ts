/**
 * IPC handlers: memory operations (write, query, read, delete, list).
 *
 * Server-side userId injection: the handler reads ctx.userId and ctx.sessionScope
 * to decide memory scoping. In DM/web contexts, memories are user-scoped (userId
 * is injected). In channel/group contexts, memories are agent-scoped (userId is
 * omitted so all writes/reads are shared). The agent never controls userId.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

/** DMs and undefined (HTTP/CLI) contexts are user-scoped. */
function isDmScope(ctx: IPCContext): boolean {
  return ctx.sessionScope === 'dm' || ctx.sessionScope === undefined;
}

export function createMemoryHandlers(providers: ProviderRegistry) {
  return {
    memory_write: async (req: any, ctx: IPCContext) => {
      const userId = isDmScope(ctx) ? ctx.userId : undefined;
      const pool = req.pool ?? 'agent';
      const scope = pool === 'company' ? 'company' : req.scope;
      const writeUserId = pool === 'company' ? undefined : userId;
      const { pool: _pool, ...rest } = req;
      const entry = { ...rest, scope, userId: writeUserId };
      await providers.audit.log({ action: 'memory_write', args: { scope, pool } });
      return { id: await providers.memory.write(entry) };
    },

    memory_query: async (req: any, ctx: IPCContext) => {
      const userId = isDmScope(ctx) ? ctx.userId : undefined;
      const pool = req.pool ?? 'both';
      const { pool: _pool, ...rest } = req;

      if (pool === 'company') {
        const query = { ...rest, scope: 'company', userId: undefined };
        return { results: await providers.memory.query(query) };
      }

      const agentResults = await providers.memory.query({ ...rest, userId });

      if (pool === 'both') {
        const companyResults = await providers.memory.query({ ...rest, scope: 'company', userId: undefined });
        // Merge and dedup by id
        const seen = new Set(agentResults.map((r: any) => r.id));
        const merged = [...agentResults];
        for (const r of companyResults) {
          if (!seen.has(r.id)) merged.push(r);
        }
        const limit = req.limit ?? 20;
        return { results: merged.slice(0, limit) };
      }

      return { results: agentResults };
    },

    memory_read: async (req: any) => {
      return { entry: await providers.memory.read(req.id) };
    },

    memory_delete: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'memory_delete', sessionId: ctx.sessionId, args: { id: req.id } });
      await providers.memory.delete(req.id);
      return { ok: true };
    },

    memory_list: async (req: any, ctx: IPCContext) => {
      const userId = isDmScope(ctx) ? ctx.userId : undefined;
      return { entries: await providers.memory.list(req.scope, req.limit, userId) };
    },
  };
}
