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
      const entry = { ...req, userId };
      await providers.audit.log({ action: 'memory_write', args: { scope: req.scope } });
      return { id: await providers.memory.write(entry) };
    },

    memory_query: async (req: any, ctx: IPCContext) => {
      const userId = isDmScope(ctx) ? ctx.userId : undefined;
      const query = { ...req, userId };
      return { results: await providers.memory.query(query) };
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
