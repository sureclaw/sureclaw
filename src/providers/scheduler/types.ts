// src/providers/scheduler/types.ts — Scheduler provider types
import type { InboundMessage, SessionAddress } from '../shared-types.js';

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
  /** Session ID of the user who created this job — used to share workspace. */
  creatorSessionId?: string;
}

export interface JobStore {
  get(jobId: string): CronJobDef | undefined | Promise<CronJobDef | undefined>;
  set(job: CronJobDef): void | Promise<void>;
  delete(jobId: string): boolean | Promise<boolean>;
  list(agentId?: string): CronJobDef[] | Promise<CronJobDef[]>;
  close(): void | Promise<void>;
  /** Atomically claim a job for a given minute key. Returns true if this caller won the claim. */
  tryClaim?(jobId: string, minuteKey: string): boolean | Promise<boolean>;
}

/** In-memory JobStore backed by a Map. Used by tests and the none scheduler. */
export class MemoryJobStore implements JobStore {
  private jobs = new Map<string, CronJobDef>();
  private lastFired = new Map<string, string>();
  get(jobId: string): CronJobDef | undefined { return this.jobs.get(jobId); }
  set(job: CronJobDef): void { this.jobs.set(job.id, job); }
  delete(jobId: string): boolean {
    this.lastFired.delete(jobId);
    return this.jobs.delete(jobId);
  }
  list(agentId?: string): CronJobDef[] {
    const all = [...this.jobs.values()];
    return agentId ? all.filter(j => j.agentId === agentId) : all;
  }
  tryClaim(jobId: string, minuteKey: string): boolean {
    if (this.lastFired.get(jobId) === minuteKey) return false;
    this.lastFired.set(jobId, minuteKey);
    return true;
  }
  close(): void { this.jobs.clear(); this.lastFired.clear(); }
}

export interface SchedulerProvider {
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  addCron?(job: CronJobDef): void | Promise<void>;
  removeCron?(jobId: string): void | Promise<void>;
  listJobs?(agentId?: string): CronJobDef[] | Promise<CronJobDef[]>;
  /** Schedule a one-shot job at a specific Date via setTimeout (exact timing). */
  scheduleOnce?(job: CronJobDef, fireAt: Date): void | Promise<void>;
  /** Manually trigger cron check at optional Date (for testing). */
  checkCronNow?(at?: Date): void | Promise<void>;
}
