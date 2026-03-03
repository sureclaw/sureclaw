import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef, JobStore } from './types.js';
import { SQLiteJobStore } from './types.js';
import type { InboundMessage } from '../shared-types.js';
import type { Config } from '../../types.js';
import { openDatabase } from '../../utils/sqlite.js';
import { dataDir, dataFile } from '../../paths.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron, minuteKey,
} from './utils.js';

interface PlainJobSchedulerDeps {
  jobStore?: JobStore;
}

export async function create(config: Config, deps: PlainJobSchedulerDeps = {}): Promise<SchedulerProvider> {
  let jobs: JobStore;

  if (deps.jobStore) {
    jobs = deps.jobStore;
  } else {
    mkdirSync(dataDir(), { recursive: true });
    const db = openDatabase(dataFile('scheduler.db'));
    jobs = new SQLiteJobStore(db);
  }

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cronTimer: ReturnType<typeof setInterval> | null = null;
  let onMessageHandler: ((msg: InboundMessage) => void) | null = null;

  // Track last-fired minute per job to prevent duplicate fires within the same minute
  const lastFiredMinute = new Map<string, string>();
  // Timers for one-shot jobs scheduled via scheduleOnce()
  const onceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Track in-flight async cleanup promises so stop() can wait for them
  const pendingCleanups = new Set<Promise<void>>();
  // Closed flag to guard deferred cleanup against closed DB
  let stopped = false;

  const activeHours: ActiveHours = {
    start: parseTime(config.scheduler.active_hours.start),
    end: parseTime(config.scheduler.active_hours.end),
    timezone: config.scheduler.active_hours.timezone,
  };

  const heartbeatIntervalMs = config.scheduler.heartbeat_interval_min * 60 * 1000;
  const agentDir = config.scheduler.agent_dir;

  // Filter cron scan to current agent to prevent cross-agent execution
  // in multi-agent deployments sharing a single scheduler.db
  const agentName = config.agent_name ?? 'main';

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

  /** Track an async cleanup so stop() can await it before closing the DB. */
  function trackCleanup(fn: () => void): void {
    if (stopped) return; // DB already closed
    try { fn(); } catch { /* ignore cleanup errors on closed DB */ }
  }

  function deferCleanup(result: unknown, fn: () => void): void {
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      const p = (result as Promise<unknown>).then(
        () => trackCleanup(fn),
        () => trackCleanup(fn),
      ) as Promise<void>;
      pendingCleanups.add(p);
      p.finally(() => pendingCleanups.delete(p));
    } else {
      fn();
    }
  }

  function fireOnceJob(job: CronJobDef): void {
    if (!onMessageHandler) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`cron:${job.id}`),
      sender: `cron:${job.id}`,
      content: job.prompt,
      attachments: [],
      timestamp: new Date(),
    });
    deferCleanup(result, () => {
      jobs.delete(job.id);
      onceTimers.delete(job.id);
    });
  }

  function checkCronJobs(at?: Date): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;
    const now = at ?? new Date();
    const mk = minuteKey(now);
    for (const job of jobs.list(agentName)) {
      if (!matchesCron(job.schedule, now)) continue;
      if (lastFiredMinute.get(job.id) === mk) continue; // already fired this minute
      lastFiredMinute.set(job.id, mk);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = onMessageHandler({
        id: randomUUID(),
        session: schedulerSession(`cron:${job.id}`),
        sender: `cron:${job.id}`,
        content: job.prompt,
        attachments: [],
        timestamp: now,
      });
      if (job.runOnce) {
        deferCleanup(result, () => {
          jobs.delete(job.id);
          lastFiredMinute.delete(job.id);
        });
      }
    }
  }

  return {
    async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
      onMessageHandler = onMessage;
      stopped = false;

      // Rehydrate persisted one-shot jobs with run_at timestamps
      if (jobs instanceof SQLiteJobStore) {
        const now = Date.now();
        for (const { job, runAt } of jobs.listWithRunAt()) {
          // Only rehydrate jobs belonging to this agent
          if (job.agentId !== agentName) continue;
          const delayMs = Math.max(0, runAt.getTime() - now);
          const timer = setTimeout(() => fireOnceJob(job), delayMs);
          onceTimers.set(job.id, timer);
        }
      }

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
      // Wait for in-flight async cleanups before closing the DB
      if (pendingCleanups.size > 0) {
        await Promise.allSettled([...pendingCleanups]);
      }
      stopped = true;
      jobs.close();
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
      return jobs.list(agentName);
    },

    scheduleOnce(job: CronJobDef, fireAt: Date): void {
      jobs.set(job);
      // Persist fire time so one-shot jobs survive restarts
      if (jobs instanceof SQLiteJobStore) {
        jobs.setRunAt(job.id, fireAt);
      }
      const delayMs = Math.max(0, fireAt.getTime() - Date.now());
      const timer = setTimeout(() => fireOnceJob(job), delayMs);
      onceTimers.set(job.id, timer);
    },

    checkCronNow(at?: Date): void {
      checkCronJobs(at);
    },
  };
}
