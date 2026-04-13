import type { Kysely } from 'kysely';
import type { CronJobDef, CronDelivery, JobStore } from './providers/scheduler/types.js';

type JobRow = {
  id: string;
  agent_id: string;
  schedule: string;
  prompt: string;
  max_token_budget: number | null;
  delivery: string | null;
  run_once: number;
  run_at: string | null;
  last_fired_at: string | null;
  creator_session_id: string | null;
};

export class KyselyJobStore implements JobStore {
  private db: Kysely<any>;

  constructor(db: Kysely<any>) {
    this.db = db;
  }

  async get(jobId: string): Promise<CronJobDef | undefined> {
    const row = await this.db.selectFrom('cron_jobs')
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at', 'creator_session_id'])
      .where('id', '=', jobId)
      .executeTakeFirst();
    if (!row) return undefined;
    return this.rowToJob(row as JobRow);
  }

  async set(job: CronJobDef): Promise<void> {
    await this.db.insertInto('cron_jobs')
      .values({
        id: job.id,
        agent_id: job.agentId,
        schedule: job.schedule,
        prompt: job.prompt,
        max_token_budget: job.maxTokenBudget ?? null,
        delivery: job.delivery ? JSON.stringify(job.delivery) : null,
        run_once: job.runOnce ? 1 : 0,
        creator_session_id: job.creatorSessionId ?? null,
      })
      .onConflict(oc => oc.column('id').doUpdateSet({
        agent_id: job.agentId,
        schedule: job.schedule,
        prompt: job.prompt,
        max_token_budget: job.maxTokenBudget ?? null,
        delivery: job.delivery ? JSON.stringify(job.delivery) : null,
        run_once: job.runOnce ? 1 : 0,
        creator_session_id: job.creatorSessionId ?? null,
      }))
      .execute();
  }

  async delete(jobId: string): Promise<boolean> {
    const result = await this.db.deleteFrom('cron_jobs')
      .where('id', '=', jobId)
      .executeTakeFirst();
    return BigInt(result.numDeletedRows) > 0n;
  }

  async list(agentId?: string): Promise<CronJobDef[]> {
    let query = this.db.selectFrom('cron_jobs')
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at', 'creator_session_id']);
    if (agentId) {
      query = query.where('agent_id', '=', agentId);
    }
    const rows = await query.execute();
    return rows.map(r => this.rowToJob(r as JobRow));
  }

  /** Persist the fire-at timestamp for a one-shot job. */
  async setRunAt(jobId: string, runAt: Date): Promise<void> {
    await this.db.updateTable('cron_jobs')
      .set({ run_at: runAt.toISOString() })
      .where('id', '=', jobId)
      .execute();
  }

  /** Return all jobs that have a persisted run_at (one-shot jobs awaiting rehydration). */
  async listWithRunAt(): Promise<Array<{ job: CronJobDef; runAt: Date }>> {
    const rows = await this.db.selectFrom('cron_jobs')
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at', 'creator_session_id'])
      .where('run_at', 'is not', null)
      .execute();
    return rows.map(r => ({
      job: this.rowToJob(r as JobRow),
      runAt: new Date(r.run_at as string),
    }));
  }

  /**
   * Atomically claim a job for firing in the given minute.
   * Returns true if this process won the claim (last_fired_at was updated).
   * Uses a simple UPDATE WHERE to ensure only one caller wins per minute.
   * On PostgreSQL with multiple replicas, the row-level lock from UPDATE
   * serializes concurrent claims naturally.
   */
  async tryClaim(jobId: string, minuteKey: string): Promise<boolean> {
    // Attempt to set last_fired_at to minuteKey only if it's currently
    // NULL or a different (earlier) minute.
    const result = await this.db.updateTable('cron_jobs')
      .set({ last_fired_at: minuteKey })
      .where('id', '=', jobId)
      .where(eb => eb.or([
        eb('last_fired_at', 'is', null),
        eb('last_fired_at', '!=', minuteKey),
      ]))
      .executeTakeFirst();
    return BigInt(result.numUpdatedRows) > 0n;
  }

  async close(): Promise<void> {
    // No-op: the shared DatabaseProvider owns the connection.
  }

  private rowToJob(row: JobRow): CronJobDef {
    const job: CronJobDef = {
      id: row.id,
      agentId: row.agent_id,
      schedule: row.schedule,
      prompt: row.prompt,
    };
    if (row.max_token_budget !== null) job.maxTokenBudget = row.max_token_budget;
    if (row.delivery) job.delivery = JSON.parse(row.delivery) as CronDelivery;
    if (row.run_once) job.runOnce = true;
    if (row.creator_session_id) job.creatorSessionId = row.creator_session_id;
    return job;
  }
}
