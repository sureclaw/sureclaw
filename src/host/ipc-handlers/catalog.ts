/**
 * IPC handlers: catalog management (publish, get, list, unpublish, set_required).
 *
 * catalog_set_required requires company admin.
 * catalog_unpublish requires author or company admin.
 */
import type { DocumentStore } from '../../providers/storage/types.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import type { IPCContext } from '../ipc-server.js';
import type { CatalogStore } from '../catalog-store.js';
import { isCompanyAdmin } from '../company-admin.js';

export function createCatalogHandlers(catalog: CatalogStore, documents: DocumentStore, audit: AuditProvider) {
  return {
    catalog_publish: async (req: any, ctx: IPCContext) => {
      const entry = await catalog.publish({
        slug: req.slug,
        type: req.type,
        name: req.name,
        description: req.description,
        author: ctx.userId ?? 'unknown',
        tags: req.tags ?? [],
        version: req.version,
        content: req.content,
      });
      await audit.log({
        action: 'catalog_publish',
        sessionId: ctx.sessionId,
        args: { slug: req.slug, version: req.version },
      });
      return { entry };
    },

    catalog_get: async (req: any, _ctx: IPCContext) => {
      const entry = await catalog.get(req.slug);
      return { entry };
    },

    catalog_list: async (req: any, _ctx: IPCContext) => {
      const entries = await catalog.list({
        type: req.type,
        tags: req.tags,
        query: req.query,
      });
      return { entries };
    },

    catalog_unpublish: async (req: any, ctx: IPCContext) => {
      const userId = ctx.userId ?? 'unknown';
      await catalog.unpublish(req.slug, userId);
      await audit.log({
        action: 'catalog_unpublish',
        sessionId: ctx.sessionId,
        args: { slug: req.slug },
      });
      return { ok: true };
    },

    catalog_set_required: async (req: any, ctx: IPCContext) => {
      if (!ctx.userId || !(await isCompanyAdmin(documents, ctx.userId))) {
        throw new Error('Only a company admin can set catalog entries as required');
      }
      await catalog.setRequired(req.slug, req.required);
      await audit.log({
        action: 'catalog_set_required',
        sessionId: ctx.sessionId,
        args: { slug: req.slug, required: req.required },
      });
      return { ok: true };
    },
  };
}
