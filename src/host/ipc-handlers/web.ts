/**
 * IPC handlers: web fetch, extract, and search.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createWebHandlers(providers: ProviderRegistry) {
  return {
    web_fetch: async (req: any, ctx: IPCContext) => {
      // Normalize: weaker models (Gemini) sometimes put the URL in `query` instead of `url`.
      const url = req.url ?? req.query;
      await providers.audit.log({ action: 'web_fetch', sessionId: ctx.sessionId, args: { url } });
      return await providers.webFetch.fetch({ ...req, url });
    },

    web_extract: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'web_extract', sessionId: ctx.sessionId, args: { url: req.url } });
      return await providers.webExtract.extract(req.url);
    },

    web_search: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'web_search', sessionId: ctx.sessionId, args: { query: req.query } });
      return await providers.webSearch.search(req.query, req.maxResults);
    },
  };
}
