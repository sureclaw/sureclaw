/**
 * IPC handlers: web fetch and search.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createWebHandlers(providers: ProviderRegistry) {
  return {
    web_fetch: async (req: any, ctx: IPCContext) => {
      // Normalize: weaker models (Gemini) sometimes put the URL in `query` instead of `url`.
      const url = req.url ?? req.query;
      await providers.audit.log({ action: 'web_fetch', sessionId: ctx.sessionId, args: { url } });
      return await providers.web.fetch({ ...req, url });
    },

    web_search: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'web_search', sessionId: ctx.sessionId, args: { query: req.query } });
      return await providers.web.search(req.query, req.maxResults);
    },
  };
}
