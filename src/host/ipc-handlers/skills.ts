/**
 * IPC handlers: skill store (read, list, propose) and audit.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';

export function createSkillsHandlers(providers: ProviderRegistry) {
  return {
    skill_read: async (req: any) => {
      return { content: await providers.skills.read(req.name) };
    },

    skill_list: async () => {
      return { skills: await providers.skills.list() };
    },

    skill_propose: async (req: any, ctx: IPCContext) => {
      await providers.audit.log({ action: 'skill_propose', sessionId: ctx.sessionId, args: { skill: req.skill } });
      return await providers.skills.propose(req);
    },

    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },
  };
}
