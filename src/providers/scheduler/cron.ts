import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef, JobStore } from './types.js';
import { MemoryJobStore } from './types.js';
import type { InboundMessage } from '../channel/types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron, minuteKey,
} from './utils.js';

interface CronSchedulerDeps {
  jobStore?: JobStore;
}

export async function create(config: Config, deps: CronSchedulerDeps = {}): Promise<SchedulerProvider> {
  const jobs: JobStore = deps.jobStore ?? new MemoryJobStore();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cronTimer: ReturnType<typeof setInterval> | null = null;
  let onMessageHandler: ((msg: InboundMessage) => void) | null = null;

  // Track last-fired minute per job to prevent duplicate fires within the same minute
  const lastFiredMinute = new Map<string, string>();
  // Timers for one-shot jobs scheduled via scheduleOnce()
  const onceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const activeHours: ActiveHours = {
    start: parseTime(config.scheduler.active_hours.start),
    end: parseTime(config.scheduler.active_hours.end),
    timezone: config.scheduler.active_hours.timezone,
  };

  const heartbeatIntervalMs = config.scheduler.heartbeat_interval_min * 60 * 1000;
  const agentDir = config.scheduler.agent_dir;

  function fireHeartbeat(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    let content = 'Heartbeat check — review pending tasks and proactive hints.';
    if (agentDir) {
      try {
        const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
        if (md.trim()) content = md;
      } catch { /* no HEARTBEAT.md — use default */ }
    }

    onMessageHandler({
      id: randomUUID(),
      session: schedulerSession('heartbeat'),
      sender: 'heartbeat',
      content,
      attachments: [],
      timestamp: new Date(),
    });
  }

  function fireOnceJob(job: CronJobDef): void {
    if (!onMessageHandler) return;
    onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`cron:${job.id}`),
      sender: `cron:${job.id}`,
      content: job.prompt,
      attachments: [],
      timestamp: new Date(),
    });
    jobs.delete(job.id);
    onceTimers.delete(job.id);
  }

  function checkCronJobs(at?: Date): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;
    const now = at ?? new Date();
    const mk = minuteKey(now);
    for (const job of jobs.list()) {
      if (!matchesCron(job.schedule, now)) continue;
      if (lastFiredMinute.get(job.id) === mk) continue; // already fired this minute
      lastFiredMinute.set(job.id, mk);
      onMessageHandler({
        id: randomUUID(),
        session: schedulerSession(`cron:${job.id}`),
        sender: `cron:${job.id}`,
        content: job.prompt,
        attachments: [],
        timestamp: now,
      });
      if (job.runOnce) {
        jobs.delete(job.id);
        lastFiredMinute.delete(job.id);
      }
    }
  }

  return {
    async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
      onMessageHandler = onMessage;

      // Heartbeat timer
      heartbeatTimer = setInterval(fireHeartbeat, heartbeatIntervalMs);

      // Cron check every 60 seconds
      cronTimer = setInterval(checkCronJobs, 60_000);
    },

    async stop(): Promise<void> {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
      }
      for (const timer of onceTimers.values()) clearTimeout(timer);
      onceTimers.clear();
      onMessageHandler = null;
    },

    addCron(job: CronJobDef): void {
      jobs.set(job);
    },

    removeCron(jobId: string): void {
      const timer = onceTimers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        onceTimers.delete(jobId);
      }
      jobs.delete(jobId);
    },

    listJobs(): CronJobDef[] {
      return jobs.list();
    },

    scheduleOnce(job: CronJobDef, fireAt: Date): void {
      jobs.set(job);
      const delayMs = Math.max(0, fireAt.getTime() - Date.now());
      const timer = setTimeout(() => fireOnceJob(job), delayMs);
      onceTimers.set(job.id, timer);
    },

    checkCronNow(at?: Date): void {
      checkCronJobs(at);
    },
  };
}
