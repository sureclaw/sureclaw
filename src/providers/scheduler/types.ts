// src/providers/scheduler/types.ts — Scheduler provider types
import type { InboundMessage, SessionAddress } from '../shared-types.js';
import type { ProactiveHint } from '../shared-types.js';

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
  get(jobId: string): CronJobDef | undefined | Promise<CronJobDef | undefined>;
  set(job: CronJobDef): void | Promise<void>;
  delete(jobId: string): boolean | Promise<boolean>;
  list(agentId?: string): CronJobDef[] | Promise<CronJobDef[]>;
  close(): void | Promise<void>;
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

export interface SchedulerProvider {
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  addCron?(job: CronJobDef): void | Promise<void>;
  removeCron?(jobId: string): void | Promise<void>;
  listJobs?(): CronJobDef[] | Promise<CronJobDef[]>;
  /** Schedule a one-shot job at a specific Date via setTimeout (exact timing). */
  scheduleOnce?(job: CronJobDef, fireAt: Date): void | Promise<void>;
  /** Manually trigger cron check at optional Date (for testing). */
  checkCronNow?(at?: Date): void | Promise<void>;
  /** Record tokens used so budget tracking can suppress hints. */
  recordTokenUsage?(tokens: number): void;
  /** List hints that were queued (budget exceeded). */
  listPendingHints?(): ProactiveHint[];
}
