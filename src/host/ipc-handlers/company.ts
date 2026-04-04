/**
 * IPC handlers: company identity read/write.
 *
 * company_identity_read: anyone can read company identity files.
 * company_identity_write: requires company admin.
 */
import type { DocumentStore } from '../../providers/storage/types.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import type { IPCContext } from '../ipc-server.js';
import { isCompanyAdmin } from '../company-admin.js';

export function createCompanyHandlers(documents: DocumentStore, audit: AuditProvider) {
  return {
    company_identity_read: async (req: any, _ctx: IPCContext) => {
      const content = await documents.get('identity', `company/${req.file}`);
      return { content: content ?? null };
    },

    company_identity_write: async (req: any, ctx: IPCContext) => {
      if (!ctx.userId || !(await isCompanyAdmin(documents, ctx.userId))) {
        throw new Error('Only a company admin can write company identity files');
      }
      const key = `company/${req.file}`;
      await documents.put('identity', key, req.content);
      await audit.log({
        action: 'company_identity_write',
        sessionId: ctx.sessionId,
        args: { file: req.file, reason: req.reason },
      });
      return { ok: true };
    },
  };
}
