// Tuple-keyed (agent_id, skill_name, env_name, user_id) credential storage.

import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { type DbDialect, sqlEpoch } from '../../migrations/dialect.js';

export interface SkillCredPutInput {
  agentId: string;
  skillName: string;
  envName: string;
  /** Empty string for agent-scope (shared across users); the userId otherwise. */
  userId: string;
  value: string;
}

export interface SkillCredGetInput {
  agentId: string;
  skillName: string;
  envName: string;
  /** Empty string selects the agent-scope sentinel row only; a real userId
   *  tries `user_id = <userId>` first then falls back to `user_id = ''`. */
  userId: string;
}

export interface SkillCredRow {
  skillName: string;
  envName: string;
  userId: string;
  value: string;
}

export interface SkillCredStore {
  put(input: SkillCredPutInput): Promise<void>;
  /** Turn-time lookup by tuple. Prefers user_id match; falls back to the
   *  agent-scope sentinel (''). Returns null when no matching row. */
  get(input: SkillCredGetInput): Promise<string | null>;
  /** Every row for the agent across skills/users. Callers sort/dedupe in JS. */
  listForAgent(agentId: string): Promise<SkillCredRow[]>;
  /** Distinct envNames across all skills/users for the agent. */
  listEnvNames(agentId: string): Promise<Set<string>>;
  /** Drop every row for (agentId, skillName) across users. Used by the
   *  orphan sweep when a skill's SKILL.md is no longer in the workspace. */
  deleteForSkill(agentId: string, skillName: string): Promise<void>;
}

export function createSkillCredStore(
  db: Kysely<any>,
  dbType: DbDialect,
): SkillCredStore {
  return {
    async put(input: SkillCredPutInput): Promise<void> {
      await db
        .insertInto('skill_credentials')
        .values({
          agent_id: input.agentId,
          skill_name: input.skillName,
          env_name: input.envName,
          user_id: input.userId,
          value: input.value,
        })
        .onConflict(oc =>
          oc
            .columns(['agent_id', 'skill_name', 'env_name', 'user_id'])
            .doUpdateSet({
              value: input.value,
              updated_at: sqlEpoch(dbType),
            }),
        )
        .execute();
    },

    async get(input: SkillCredGetInput): Promise<string | null> {
      // Prefer a row where user_id matches exactly; fall back to the
      // agent-scope sentinel (''). When userId is '' the OR collapses to a
      // single candidate and both ORDER BY terms are false — still correct.
      const rows = await db
        .selectFrom('skill_credentials')
        .select(['user_id', 'value'])
        .where('agent_id', '=', input.agentId)
        .where('skill_name', '=', input.skillName)
        .where('env_name', '=', input.envName)
        .where(eb =>
          eb.or([
            eb('user_id', '=', input.userId),
            eb('user_id', '=', ''),
          ]),
        )
        .execute();
      if (rows.length === 0) return null;
      // Order in JS so both SQLite and PostgreSQL share the same precedence
      // logic: prefer the user_id === input.userId row over user_id === ''.
      rows.sort((a, b) => {
        const aScore = a.user_id === input.userId ? 0 : 1;
        const bScore = b.user_id === input.userId ? 0 : 1;
        return aScore - bScore;
      });
      return rows[0].value as string;
    },

    async listForAgent(agentId: string): Promise<SkillCredRow[]> {
      const rows = await db
        .selectFrom('skill_credentials')
        .select(['skill_name', 'env_name', 'user_id', 'value'])
        .where('agent_id', '=', agentId)
        .execute();
      return rows.map(r => ({
        skillName: r.skill_name as string,
        envName: r.env_name as string,
        userId: r.user_id as string,
        value: r.value as string,
      }));
    },

    async listEnvNames(agentId: string): Promise<Set<string>> {
      const rows = await db
        .selectFrom('skill_credentials')
        .select(sql<string>`DISTINCT env_name`.as('env_name'))
        .where('agent_id', '=', agentId)
        .execute();
      return new Set(rows.map(r => r.env_name as string));
    },

    async deleteForSkill(agentId: string, skillName: string): Promise<void> {
      await db
        .deleteFrom('skill_credentials')
        .where('agent_id', '=', agentId)
        .where('skill_name', '=', skillName)
        .execute();
    },
  };
}
