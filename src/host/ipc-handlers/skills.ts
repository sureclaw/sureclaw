/**
 * IPC handlers: skill search (ClawHub), skill download, audit, and credential requests.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import * as clawhub from '../../clawhub/registry-client.js';
import { resolveCredential } from '../credential-scopes.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc-skills' });

export interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skill_search: async (req: any, ctx: IPCContext) => {
      const { query, limit } = req;
      const results = await clawhub.search(query, limit ?? 20);
      await providers.audit.log({
        action: 'skill_search',
        sessionId: ctx.sessionId,
        args: { query },
      });
      return { results };
    },

    skill_download: async (req: any, ctx: IPCContext) => {
      const { slug } = req;
      logger.info('skill_download_start', { slug, sessionId: ctx.sessionId });

      const pkg = await clawhub.fetchSkillPackage(slug);

      await providers.audit.log({
        action: 'skill_download',
        sessionId: ctx.sessionId,
        args: { slug, fileCount: pkg.files.length, requiresEnv: pkg.requiresEnv },
      });

      // Return files + credential requirements so the agent can write locally
      // and call request_credential for each missing env var
      return {
        slug: pkg.slug,
        displayName: pkg.displayName,
        files: pkg.files,
        requiresEnv: pkg.requiresEnv,
      };
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

      // Check if credential is already available (user scope → agent scope)
      const agentName = ctx.agentId ?? 'main';
      const available = (await resolveCredential(providers.credentials, envName, agentName, ctx.userId)) !== null;

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
