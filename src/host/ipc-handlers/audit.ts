import type { ProviderRegistry } from '../../types.js';

export function createAuditHandlers(providers: ProviderRegistry) {
  return {
    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },
  };
}
