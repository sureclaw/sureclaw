/**
 * IPC handlers: skill store (read, list, propose, import, search) and audit.
 */
import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { parseAgentSkill } from '../../utils/skill-format-parser.js';
import { generateManifest } from '../../utils/manifest-generator.js';
import * as clawhub from '../../clawhub/registry-client.js';

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

    skill_import: async (req: any, ctx: IPCContext) => {
      const { source, autoApprove } = req;

      // 1. Resolve source: clawhub:<name> or local SKILL.md content
      let skillMd: string;
      if (typeof source === 'string' && source.startsWith('clawhub:')) {
        const name = source.slice('clawhub:'.length);
        const detail = await clawhub.fetchSkill(name);
        skillMd = detail.skillMd;
      } else {
        skillMd = source;
      }

      // 2. Parse
      const parsed = parseAgentSkill(skillMd);

      // 3. Screen
      let screenResult;
      if (providers.skillScreener?.screenExtended) {
        screenResult = await providers.skillScreener.screenExtended(skillMd, parsed.permissions);
      } else if (providers.skillScreener) {
        const basic = await providers.skillScreener.screen(skillMd, parsed.permissions);
        screenResult = {
          verdict: basic.allowed ? 'APPROVE' as const : 'REJECT' as const,
          score: basic.allowed ? 0 : 1,
          reasons: basic.reasons.map(r => ({ category: 'screener', severity: 'FLAG' as const, detail: r })),
          permissions: parsed.permissions,
          excessPermissions: [],
        };
      } else {
        screenResult = { verdict: 'APPROVE' as const, score: 0, reasons: [], permissions: [], excessPermissions: [] };
      }

      if (screenResult.verdict === 'REJECT') {
        await providers.audit.log({
          action: 'skill_import_rejected',
          sessionId: ctx.sessionId,
          args: { skill: parsed.name, reasons: screenResult.reasons.map(r => r.detail) },
        });
        return {
          status: 'rejected',
          skill: parsed.name,
          screening: screenResult,
        };
      }

      // 4. Generate manifest
      const manifest = generateManifest(parsed);

      // 5. Propose
      const proposal = await providers.skills.propose({
        skill: parsed.name || 'imported-skill',
        content: skillMd,
        reason: `Imported from ${source.startsWith('clawhub:') ? 'ClawHub' : 'local'}. Screening: ${screenResult.verdict}`,
      });

      await providers.audit.log({
        action: 'skill_import',
        sessionId: ctx.sessionId,
        args: { skill: parsed.name, verdict: screenResult.verdict, proposalId: proposal.id },
      });

      return {
        status: 'imported',
        skill: parsed.name,
        screening: screenResult,
        manifest,
        proposal,
      };
    },

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

    audit_query: async (req: any) => {
      return { entries: await providers.audit.query(req.filter ?? {}) };
    },
  };
}
