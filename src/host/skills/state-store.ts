// src/host/skills/state-store.ts — SQLite-backed persistence for skill states
// and per-agent setup queue. Both tables are authoritatively rewritten per agent
// on each reconcile: delete-all-for-agent + insert the new set, in one
// transaction, so we never leave stale rows for skills removed from the repo.
import type { Kysely, Transaction } from 'kysely';
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

  /**
   * Atomic: replace both skill_states and skill_setup_queue for the agent in a
   * single transaction. Prefer this over separate putStates + putSetupQueue
   * calls when both must succeed or fail together (reconcile always does).
   */
  putStatesAndQueue(
    agentId: string,
    states: SkillState[],
    queue: SetupRequest[],
  ): Promise<void>;
}

// Transaction-scoped helpers — used by both the single-table public methods
// (each wrapped in its own transaction) and putStatesAndQueue (one
// transaction spanning both tables). Keeps the delete+insert logic in one
// place so drift between the two code paths is impossible.
async function replaceStatesInTrx(
  trx: Transaction<any>,
  agentId: string,
  states: SkillState[],
): Promise<void> {
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
}

async function replaceSetupQueueInTrx(
  trx: Transaction<any>,
  agentId: string,
  queue: SetupRequest[],
): Promise<void> {
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
        await replaceStatesInTrx(trx, agentId, states);
      });
    },

    async putSetupQueue(agentId, queue) {
      await db.transaction().execute(async trx => {
        await replaceSetupQueueInTrx(trx, agentId, queue);
      });
    },

    async putStatesAndQueue(agentId, states, queue) {
      // Single transaction spanning both tables. If the queue insert fails,
      // the states delete/insert is rolled back too — no half-updated DB
      // with stale skill_states and fresh skill_setup_queue or vice versa.
      await db.transaction().execute(async trx => {
        await replaceStatesInTrx(trx, agentId, states);
        await replaceSetupQueueInTrx(trx, agentId, queue);
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
