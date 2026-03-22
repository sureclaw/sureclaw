/**
 * IPC handlers: skill install (ClawHub), audit, and credential requests.
 *
 * skill_install replaces the old skill_search + skill_download pair.
 * The host now downloads, screens, generates a manifest, writes files,
 * and adds domains to the proxy allowlist — all on the trusted side.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { EventBus } from '../event-bus.js';
import type { ProxyDomainList } from '../proxy-domain-list.js';
import * as clawhub from '../../clawhub/registry-client.js';
import { parseAgentSkill } from '../../utils/skill-format-parser.js';
import { generateManifest } from '../../utils/manifest-generator.js';
import { userSkillsDir } from '../../paths.js';
import { resolveCredential } from '../credential-scopes.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'ipc-skills' });

export interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
  eventBus?: EventBus;
  domainList?: ProxyDomainList;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skill_install: async (req: any, ctx: IPCContext) => {
      // 1. If query provided (not slug), search ClawHub first
      let slug = req.slug;
      if (!slug && req.query) {
        const results = await clawhub.search(req.query, 5);
        if (results.length === 0) return { installed: false, reason: 'No matching skills found' };
        slug = results[0].slug;
      }
      if (!slug) return { installed: false, reason: 'Provide query or slug' };

      logger.info('skill_install_start', { slug, sessionId: ctx.sessionId });

      // 2. Download from ClawHub (resolves author/name → name if needed)
      const pkg = await clawhub.fetchSkillPackage(slug);
      // Use the resolved slug (e.g. "ManuelHettich/linear" → "linear")
      slug = pkg.slug;

      // 3. Parse and screen the SKILL.md
      const skillMd = pkg.files.find(f => f.path.endsWith('SKILL.md') || f.path.endsWith('.md'));
      if (!skillMd) return { installed: false, reason: 'No SKILL.md found in package' };
      const parsed = parseAgentSkill(skillMd.content);

      // 4. Generate manifest (extracts domains, bins, etc.)
      const manifest = generateManifest(parsed);

      // 5. Write files to skills directory (host-controlled)
      const agentName = ctx.agentId ?? 'main';
      const userId = ctx.userId ?? 'default';
      const skillDir = join(userSkillsDir(agentName, userId), slug);
      mkdirSync(skillDir, { recursive: true });
      for (const file of pkg.files) {
        const filePath = join(skillDir, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
      }

      // 5b. Queue skill files for GCS commit so they persist across sessions.
      // In k8s mode, the sandbox pod can't access the host filesystem — skill
      // files must go through the workspace provider (GCS) to survive pod restarts.
      if (providers.workspace?.setRemoteChanges && ctx.sessionId) {
        const remoteChanges = pkg.files.map(file => ({
          scope: 'user' as const,
          path: `skills/${slug}/${file.path}`,
          type: 'added' as const,
          content: Buffer.from(file.content, 'utf-8'),
          size: Buffer.byteLength(file.content, 'utf-8'),
        }));
        providers.workspace.setRemoteChanges(ctx.sessionId, remoteChanges);
        logger.info('skill_files_queued_for_gcs', { slug, fileCount: remoteChanges.length, sessionId: ctx.sessionId });
      }

      // 6. Add domains to proxy allowlist
      if (opts?.domainList && manifest.capabilities.domains.length > 0) {
        opts.domainList.addSkillDomains(slug, manifest.capabilities.domains);
      }

      await providers.audit.log({
        action: 'skill_install',
        sessionId: ctx.sessionId,
        args: { slug, domains: manifest.capabilities.domains },
        result: 'success',
      });

      logger.info('skill_install_complete', {
        slug,
        fileCount: pkg.files.length,
        domains: manifest.capabilities.domains,
        sessionId: ctx.sessionId,
      });

      return {
        installed: true,
        name: parsed.name || slug,
        slug,
        requiresEnv: pkg.requiresEnv,
        domains: manifest.capabilities.domains,
        installSteps: parsed.install.length,
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

      // Check if credential is already available (user scope -> agent scope)
      const agentName = ctx.agentId ?? 'main';
      const available = (await resolveCredential(providers.credentials, envName, agentName, ctx.userId)) !== null;

      // Emit credential.required so the SSE stream notifies the client
      if (!available && opts?.eventBus && ctx.requestId) {
        opts.eventBus.emit({
          type: 'credential.required',
          requestId: ctx.requestId,
          timestamp: Date.now(),
          data: { envName, sessionId: ctx.sessionId, agentName, userId: ctx.userId },
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
