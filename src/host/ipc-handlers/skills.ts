/**
 * IPC handlers: skill install (ClawHub), audit, and credential requests.
 *
 * skill_install replaces the old skill_search + skill_download pair.
 * The host now downloads, screens, generates a manifest, writes files,
 * and adds domains to the proxy allowlist — all on the trusted side.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { EventBus } from '../event-bus.js';
import type { ProxyDomainList } from '../proxy-domain-list.js';
import * as clawhub from '../../clawhub/registry-client.js';
import { parseAgentSkill } from '../../utils/skill-format-parser.js';
import { generateManifest } from '../../utils/manifest-generator.js';
import { resolveCredential } from '../credential-scopes.js';
import { getLogger } from '../../logger.js';
import { upsertSkill, getSkill, deleteSkill, inferMcpApps } from '../../providers/storage/skills.js';

const logger = getLogger().child({ component: 'ipc-skills' });

export interface SkillsHandlerOptions {
  requestedCredentials?: Map<string, Set<string>>;
  eventBus?: EventBus;
  domainList?: ProxyDomainList;
}

export function createSkillsHandlers(providers: ProviderRegistry, opts?: SkillsHandlerOptions) {
  return {
    skill_install: async (req: any, ctx: IPCContext) => {
      // 1. Extract slug from ClawHub URL, query, or direct slug
      let slug = req.slug;

      // Parse ClawHub URLs in either slug or query field
      // e.g. "https://clawhub.ai/ManuelHettich/linear" → "ManuelHettich/linear"
      const rawInput = slug || req.query || '';
      const clawHubMatch = rawInput.match(/clawhub\.ai\/([^?#\s]+)/);
      if (clawHubMatch) {
        slug = clawHubMatch[1].replace(/\/+$/, ''); // strip trailing slashes
      } else if (!slug && req.query) {
        // No URL detected — fall back to search
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

      // 3. Parse and screen the SKILL.md (require exact SKILL.md, don't accept any .md)
      const skillMd = pkg.files.find(f => f.path === 'SKILL.md' || f.path.endsWith('/SKILL.md'));
      if (!skillMd) return { installed: false, reason: 'No SKILL.md found in package' };
      const parsed = parseAgentSkill(skillMd.content);

      // 4. Generate manifest (extracts domains, bins, etc.)
      const manifest = generateManifest(parsed);

      // 5. Store skill in DB (primary persistence)
      const agentName = ctx.agentId ?? 'main';
      if (!providers.storage?.documents) {
        return { installed: false, reason: 'No storage provider available' };
      }
      const mcpApps = inferMcpApps(skillMd.content);
      await upsertSkill(providers.storage.documents, {
        id: slug,
        agentId: agentName,
        version: '1.0.0',
        instructions: skillMd.content,
        files: pkg.files.map(f => ({ path: f.path, content: f.content })),
        mcpApps,
      });
      logger.info('skill_stored_in_db', { slug, agentId: agentName, mcpApps });

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

    skill_update: async (req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { ok: false, error: 'No storage provider' };
      const agentName = ctx.agentId ?? 'main';
      const existing = await getSkill(providers.storage.documents, agentName, req.slug);
      if (!existing) return { ok: false, error: 'Skill not found' };

      const files = existing.files ?? [{ path: 'SKILL.md', content: existing.instructions }];
      const idx = files.findIndex(f => f.path === req.path);
      if (idx >= 0) {
        files[idx].content = req.content;
      } else {
        files.push({ path: req.path, content: req.content });
      }

      const skillMd = files.find(f => f.path === 'SKILL.md');
      const instructions = skillMd?.content ?? existing.instructions;

      // Resync derived metadata (mcpApps, domains) after content change
      const mcpApps = skillMd ? inferMcpApps(skillMd.content) : existing.mcpApps;
      await upsertSkill(providers.storage.documents, {
        ...existing,
        instructions,
        files,
        mcpApps,
      });

      // Resync proxy allowlist domains from updated SKILL.md
      if (opts?.domainList && skillMd) {
        try {
          const parsed = parseAgentSkill(skillMd.content);
          const manifest = generateManifest(parsed);
          if (manifest.capabilities.domains.length > 0) {
            opts.domainList.addSkillDomains(req.slug, manifest.capabilities.domains);
          } else {
            opts.domainList.removeSkillDomains(req.slug);
          }
        } catch { /* skip if unparseable */ }
      }

      await providers.audit.log({
        action: 'skill_update',
        sessionId: ctx.sessionId,
        args: { slug: req.slug, path: req.path },
        result: 'success',
      });

      return { ok: true, updated: req.path };
    },

    skill_delete: async (req: any, ctx: IPCContext) => {
      if (!providers.storage?.documents) return { ok: false, error: 'No storage provider' };
      const agentName = ctx.agentId ?? 'main';
      const deleted = await deleteSkill(providers.storage.documents, agentName, req.slug);

      // Remove skill's domains from proxy allowlist
      if (deleted && opts?.domainList) {
        opts.domainList.removeSkillDomains(req.slug);
      }

      await providers.audit.log({
        action: 'skill_delete',
        sessionId: ctx.sessionId,
        args: { slug: req.slug },
        result: deleted ? 'success' : 'error',
      });

      return { ok: deleted, slug: req.slug };
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
