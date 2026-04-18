/**
 * IPC handlers: skills_index, credential_request, audit_query.
 *
 * Skill authoring (install/create/update/delete) now happens git-natively:
 * agents write files under `.ax/skills/<name>/` in the workspace, and the
 * host reconciles them via git hooks instead of dedicated IPC actions.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { EventBus } from '../event-bus.js';
import type { SkillStateStore } from '../skills/state-store.js';
import { resolveCredential } from '../credential-scopes.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc-skills' });

export interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
  eventBus?: EventBus;
  stateStore?: SkillStateStore;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skills_index: async (_req: unknown, ctx: IPCContext) => {
      if (!opts?.stateStore) return { skills: [] };
      const states = await opts.stateStore.getStates(ctx.agentId);
      const skills = states.map(s => {
        const out: { name: string; kind: string; description?: string; pendingReasons?: string[] } = {
          name: s.name,
          kind: s.kind,
        };
        if (s.description) out.description = s.description;
        if (s.pendingReasons?.length) out.pendingReasons = s.pendingReasons;
        return out;
      });
      return { skills };
    },

    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },

    credential_request: async (req: any, ctx: IPCContext) => {
      const { envName } = req;
      if (opts?.requestedCredentials) {
        let envNames = opts.requestedCredentials.get(ctx.sessionId);
        if (!envNames) {
          envNames = new Set();
          opts.requestedCredentials.set(ctx.sessionId, envNames);
        }
        envNames.add(envName);
      }

      // Check if credential is already available (user scope -> agent scope)
      const agentId = ctx.agentId;
      const available = (await resolveCredential(providers.credentials, envName, agentId, ctx.userId)) !== null;

      // Emit credential.required so the SSE stream notifies the client
      if (!available && opts?.eventBus && ctx.requestId) {
        opts.eventBus.emit({
          type: 'credential.required',
          requestId: ctx.requestId,
          timestamp: Date.now(),
          data: { envName, sessionId: ctx.sessionId, agentId, userId: ctx.userId },
        });
      }

      logger.info('credential_request_recorded', { envName, sessionId: ctx.sessionId, available });
      await providers.audit.log({
        action: 'credential_request',
        sessionId: ctx.sessionId,
        args: { envName, available },
      });
      return { ok: true, available };
    },
  };
}
