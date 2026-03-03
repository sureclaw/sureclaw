// src/providers/scheduler/types.ts — Scheduler provider types
import type { InboundMessage, SessionAddress } from '../shared-types.js';
import type { ProactiveHint } from '../shared-types.js';
import type { SQLiteDatabase } from '../../utils/sqlite.js';

export interface CronDelivery {
  mode: 'channel' | 'none';
  target?: SessionAddress | 'last';
}

export interface CronJobDef {
  id: string;
  schedule: string;
  agentId: string;
  prompt: string;
  maxTokenBudget?: number;
  delivery?: CronDelivery;
  runOnce?: boolean;
}

export interface JobStore {
  get(jobId: string): CronJobDef | undefined;
  set(job: CronJobDef): void;
  delete(jobId: string): boolean;
  list(agentId?: string): CronJobDef[];
  close(): void;
}

/** In-memory JobStore backed by a Map. Used by tests and the none scheduler. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, CronJobDef>();
  get(jobId: string): CronJobDef | undefined { return this.jobs.get(jobId); }
  set(job: CronJobDef): void { this.jobs.set(job.id, job); }
  delete(jobId: string): boolean { return this.jobs.delete(jobId); }
  list(agentId?: string): CronJobDef[] {
    const all = [...this.jobs.values()];
    return agentId ? all.filter(j => j.agentId === agentId) : all;
  }
  close(): void { this.jobs.clear(); }
}

/** SQLite-backed JobStore. Persists jobs across process restarts. */
export class SQLiteJobStore implements JobStore {
  private db: SQLiteDatabase;

  constructor(db: SQLiteDatabase) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduler_jobs (
        id          TEXT PRIMARY KEY,
        schedule    TEXT NOT NULL,
        agent_id    TEXT NOT NULL,
        prompt      TEXT NOT NULL,
        max_token_budget INTEGER,
        delivery    TEXT,
        run_once    INTEGER NOT NULL DEFAULT 0,
        run_at      TEXT
      )
    `);
    // Migration: add run_at column to tables created before this column existed
    try { this.db.exec('ALTER TABLE scheduler_jobs ADD COLUMN run_at TEXT'); } catch { /* already exists */ }
  }

  get(jobId: string): CronJobDef | undefined {
    const row = this.db.prepare('SELECT * FROM scheduler_jobs WHERE id = ?').get(jobId) as Record<string, unknown> | undefined;
    return row ? this.rowToJob(row) : undefined;
  }

  set(job: CronJobDef): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO scheduler_jobs (id, schedule, agent_id, prompt, max_token_budget, delivery, run_once)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      job.id,
      job.schedule,
      job.agentId,
      job.prompt,
      job.maxTokenBudget ?? null,
      job.delivery ? JSON.stringify(job.delivery) : null,
      job.runOnce ? 1 : 0,
    );
  }

  delete(jobId: string): boolean {
    const before = this.db.prepare('SELECT COUNT(*) as cnt FROM scheduler_jobs WHERE id = ?').get(jobId) as { cnt: number };
    this.db.prepare('DELETE FROM scheduler_jobs WHERE id = ?').run(jobId);
    return (before?.cnt ?? 0) > 0;
  }

  list(agentId?: string): CronJobDef[] {
    const rows = agentId
      ? this.db.prepare('SELECT * FROM scheduler_jobs WHERE agent_id = ?').all(agentId) as Record<string, unknown>[]
      : this.db.prepare('SELECT * FROM scheduler_jobs').all() as Record<string, unknown>[];
    return rows.map(r => this.rowToJob(r));
  }

  /** Persist the fire-at timestamp for a one-shot job. */
  setRunAt(jobId: string, runAt: Date): void {
    this.db.prepare('UPDATE scheduler_jobs SET run_at = ? WHERE id = ?')
      .run(runAt.toISOString(), jobId);
  }

  /** Return all jobs that have a persisted run_at (one-shot jobs awaiting rehydration). */
  listWithRunAt(): Array<{ job: CronJobDef; runAt: Date }> {
    const rows = this.db.prepare('SELECT * FROM scheduler_jobs WHERE run_at IS NOT NULL')
      .all() as Record<string, unknown>[];
    return rows.map(r => ({
      job: this.rowToJob(r),
      runAt: new Date(r.run_at as string),
    }));
  }

  close(): void {
    this.db.close();
  }

  private rowToJob(row: Record<string, unknown>): CronJobDef {
    return {
      id: row.id as string,
      schedule: row.schedule as string,
      agentId: row.agent_id as string,
      prompt: row.prompt as string,
      maxTokenBudget: row.max_token_budget as number | undefined,
      delivery: row.delivery ? JSON.parse(row.delivery as string) : undefined,
      runOnce: (row.run_once as number) === 1,
    };
  }
}

export interface SchedulerProvider {
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  addCron?(job: CronJobDef): void;
  removeCron?(jobId: string): void;
  listJobs?(): CronJobDef[];
  /** Schedule a one-shot job at a specific Date via setTimeout (exact timing). */
  scheduleOnce?(job: CronJobDef, fireAt: Date): void;
  /** Manually trigger cron check at optional Date (for testing). */
  checkCronNow?(at?: Date): void;
  /** Record tokens used so budget tracking can suppress hints. */
  recordTokenUsage?(tokens: number): void;
  /** List hints that were queued (budget exceeded). */
  listPendingHints?(): ProactiveHint[];
}
