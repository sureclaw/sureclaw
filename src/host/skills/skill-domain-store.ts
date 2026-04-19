// Tuple-keyed (agent_id, skill_name, domain) approval storage.

import type { Kysely } from 'kysely';

export interface SkillDomainApproveInput {
  agentId: string;
  skillName: string;
  domain: string;
}

export interface SkillDomainApprovalRow {
  skillName: string;
  domain: string;
}

export interface SkillDomainStore {
  approve(input: SkillDomainApproveInput): Promise<void>;
  /** All approved (skill_name, domain) pairs for an agent. */
  listForAgent(agentId: string): Promise<SkillDomainApprovalRow[]>;
  /** Drop every approval for (agentId, skillName). Used by the orphan sweep
   *  when a skill's SKILL.md is no longer in the workspace. */
  deleteForSkill(agentId: string, skillName: string): Promise<void>;
}

export function createSkillDomainStore(db: Kysely<any>): SkillDomainStore {
  return {
    async approve(input: SkillDomainApproveInput): Promise<void> {
      await db
        .insertInto('skill_domain_approvals')
        .values({
          agent_id: input.agentId,
          skill_name: input.skillName,
          domain: input.domain,
        })
        .onConflict(oc =>
          oc.columns(['agent_id', 'skill_name', 'domain']).doNothing(),
        )
        .execute();
    },

    async listForAgent(agentId: string): Promise<SkillDomainApprovalRow[]> {
      const rows = await db
        .selectFrom('skill_domain_approvals')
        .select(['skill_name', 'domain'])
        .where('agent_id', '=', agentId)
        .execute();
      return rows.map(r => ({
        skillName: r.skill_name as string,
        domain: r.domain as string,
      }));
    },

    async deleteForSkill(agentId: string, skillName: string): Promise<void> {
      await db
        .deleteFrom('skill_domain_approvals')
        .where('agent_id', '=', agentId)
        .where('skill_name', '=', skillName)
        .execute();
    },
  };
}
