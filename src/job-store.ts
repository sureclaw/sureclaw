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
};

export class KyselyJobStore implements JobStore {
  private db: Kysely<any>;

  constructor(db: Kysely<any>) {
    this.db = db;
  }

  async get(jobId: string): Promise<CronJobDef | undefined> {
    const row = await this.db.selectFrom('cron_jobs')
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at'])
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
      })
      .onConflict(oc => oc.column('id').doUpdateSet({
        agent_id: job.agentId,
        schedule: job.schedule,
        prompt: job.prompt,
        max_token_budget: job.maxTokenBudget ?? null,
        delivery: job.delivery ? JSON.stringify(job.delivery) : null,
        run_once: job.runOnce ? 1 : 0,
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
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at']);
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
      .select(['id', 'agent_id', 'schedule', 'prompt', 'max_token_budget', 'delivery', 'run_once', 'run_at'])
      .where('run_at', 'is not', null)
      .execute();
    return rows.map(r => ({
      job: this.rowToJob(r as JobRow),
      runAt: new Date(r.run_at as string),
    }));
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
    return job;
  }
}
