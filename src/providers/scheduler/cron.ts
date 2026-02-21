import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef } from './types.js';
import type { InboundMessage } from '../channel/types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron,
} from './utils.js';

export async function create(config: Config): Promise<SchedulerProvider> {
  const jobs: Map<string, CronJobDef> = new Map();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let cronTimer: ReturnType<typeof setInterval> | null = null;
  let onMessageHandler: ((msg: InboundMessage) => void) | null = null;

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

  function checkCronJobs(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;
    const now = new Date();
    for (const job of jobs.values()) {
      if (!matchesCron(job.schedule, now)) continue;
      onMessageHandler({
        id: randomUUID(),
        session: schedulerSession(`cron:${job.id}`),
        sender: `cron:${job.id}`,
        content: job.prompt,
        attachments: [],
        timestamp: now,
      });
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
      onMessageHandler = null;
    },

    addCron(job: CronJobDef): void {
      jobs.set(job.id, job);
    },

    removeCron(jobId: string): void {
      jobs.delete(jobId);
    },

    listJobs(): CronJobDef[] {
      return [...jobs.values()];
    },
  };
}
