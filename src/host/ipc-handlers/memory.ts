/**
 * IPC handlers: memory operations (write, query, read, delete, list).
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createMemoryHandlers(providers: ProviderRegistry) {
  return {
    memory_write: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'memory_write', args: { scope: req.scope } });
      return { id: await providers.memory.write(req) };
    },

    memory_query: async (req: any) => {
      return { results: await providers.memory.query(req) };
    },

    memory_read: async (req: any) => {
      return { entry: await providers.memory.read(req.id) };
    },

    memory_delete: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'memory_delete', sessionId: ctx.sessionId, args: { id: req.id } });
      await providers.memory.delete(req.id);
      return { ok: true };
    },

    memory_list: async (req: any) => {
      return { entries: await providers.memory.list(req.scope, req.limit) };
    },
  };
}
