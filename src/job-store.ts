import { openDatabase } from './utils/sqlite.js';
import type { SQLiteDatabase } from './utils/sqlite.js';
import { dataFile } from './paths.js';
import type { CronJobDef, CronDelivery, JobStore } from './providers/scheduler/types.js';

type JobRow = {
  id: string; agent_id: string; schedule: string; prompt: string;
  max_token_budget: number | null; delivery: string | null; run_once: number;
};

export class SqliteJobStore implements JobStore {
  private db: SQLiteDatabase;

  constructor(dbPath: string = dataFile('jobs.db')) {
    this.db = openDatabase(dbPath);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id        TEXT PRIMARY KEY,
        agent_id  TEXT NOT NULL,
        schedule  TEXT NOT NULL,
        prompt    TEXT NOT NULL,
        max_token_budget INTEGER,
        delivery  TEXT,
        run_once  INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cron_jobs_agent ON cron_jobs(agent_id)
    `);
  }

  get(jobId: string): CronJobDef | undefined {
    const row = this.db.prepare(
      'SELECT id, agent_id, schedule, prompt, max_token_budget, delivery, run_once FROM cron_jobs WHERE id = ?'
    ).get(jobId) as JobRow | undefined;
    if (!row) return undefined;
    return this.rowToJob(row);
  }

  set(job: CronJobDef): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO cron_jobs (id, agent_id, schedule, prompt, max_token_budget, delivery, run_once)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      job.id,
      job.agentId,
      job.schedule,
      job.prompt,
      job.maxTokenBudget ?? null,
      job.delivery ? JSON.stringify(job.delivery) : null,
      job.runOnce ? 1 : 0,
    );
  }

  delete(jobId: string): boolean {
    const row = this.db.prepare('DELETE FROM cron_jobs WHERE id = ? RETURNING id').get(jobId);
    return row !== undefined;
  }

  list(agentId?: string): CronJobDef[] {
    if (agentId) {
      const rows = this.db.prepare(
        'SELECT id, agent_id, schedule, prompt, max_token_budget, delivery, run_once FROM cron_jobs WHERE agent_id = ?'
      ).all(agentId) as JobRow[];
      return rows.map(r => this.rowToJob(r));
    }
    const rows = this.db.prepare(
      'SELECT id, agent_id, schedule, prompt, max_token_budget, delivery, run_once FROM cron_jobs'
    ).all() as JobRow[];
    return rows.map(r => this.rowToJob(r));
  }

  close(): void {
    this.db.close();
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
