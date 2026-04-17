// src/host/skills/state-store.ts — SQLite-backed persistence for skill states
// and per-agent setup queue. Both tables are authoritatively rewritten per agent
// on each reconcile: delete-all-for-agent + insert the new set, in one
// transaction, so we never leave stale rows for skills removed from the repo.
import type { Kysely } from 'kysely';
import type { SkillState, SetupRequest, SkillStateKind } from './types.js';

export interface SkillStateStore {
  /** Return the prior kind per skill for the given agent. Empty map if none. */
  getPriorStates(agentId: string): Promise<Map<string, SkillStateKind>>;

  /**
   * Authoritatively replace all skill_states rows for the agent with the given
   * list. Empty list clears the agent's rows. Single transaction.
   */
  putStates(agentId: string, states: SkillState[]): Promise<void>;

  /**
   * Authoritatively replace all skill_setup_queue rows for the agent with the
   * given list. Empty list clears the agent's queue. Single transaction.
   */
  putSetupQueue(agentId: string, queue: SetupRequest[]): Promise<void>;

  /** Return the agent's persisted setup queue. Empty array if none. */
  getSetupQueue(agentId: string): Promise<SetupRequest[]>;
}

export function createSkillStateStore(db: Kysely<any>): SkillStateStore {
  return {
    async getPriorStates(agentId) {
      const rows = await db
        .selectFrom('skill_states')
        .select(['skill_name', 'kind'])
        .where('agent_id', '=', agentId)
        .execute();
      const out = new Map<string, SkillStateKind>();
      for (const r of rows as Array<{ skill_name: string; kind: string }>) {
        out.set(r.skill_name, r.kind as SkillStateKind);
      }
      return out;
    },

    async putStates(agentId, states) {
      await db.transaction().execute(async trx => {
        await trx
          .deleteFrom('skill_states')
          .where('agent_id', '=', agentId)
          .execute();

        if (states.length === 0) return;

        const rows = states.map(s => ({
          agent_id: agentId,
          skill_name: s.name,
          kind: s.kind,
          description: s.description ?? null,
          pending_reasons: s.pendingReasons ? JSON.stringify(s.pendingReasons) : null,
          error: s.error ?? null,
        }));

        await trx.insertInto('skill_states').values(rows).execute();
      });
    },

    async putSetupQueue(agentId, queue) {
      await db.transaction().execute(async trx => {
        await trx
          .deleteFrom('skill_setup_queue')
          .where('agent_id', '=', agentId)
          .execute();

        if (queue.length === 0) return;

        const rows = queue.map(req => ({
          agent_id: agentId,
          skill_name: req.skillName,
          payload: JSON.stringify(req),
        }));

        await trx.insertInto('skill_setup_queue').values(rows).execute();
      });
    },

    async getSetupQueue(agentId) {
      const rows = await db
        .selectFrom('skill_setup_queue')
        .select(['payload'])
        .where('agent_id', '=', agentId)
        .orderBy('skill_name', 'asc')
        .execute();
      return (rows as Array<{ payload: string }>).map(r =>
        JSON.parse(r.payload) as SetupRequest,
      );
    },
  };
}
