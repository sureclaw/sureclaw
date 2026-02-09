import { randomUUID } from 'node:crypto';
import type {
  SchedulerProvider,
  InboundMessage,
  CronJobDef,
  Config,
} from '../types.js';

interface ActiveHours {
  start: number; // minutes from midnight
  end: number;
  timezone: string;
}

function parseTime(timeStr: string): number {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function isWithinActiveHours(hours: ActiveHours): boolean {
  const now = new Date();
  // Get current time in the configured timezone
  const timeStr = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: hours.timezone,
  });
  const currentMinutes = parseTime(timeStr);
  return currentMinutes >= hours.start && currentMinutes < hours.end;
}

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

  function fireHeartbeat(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    const msg: InboundMessage = {
      id: randomUUID(),
      channel: 'scheduler',
      sender: 'heartbeat',
      content: 'Heartbeat check — review pending tasks and proactive hints.',
      timestamp: new Date(),
      isGroup: false,
    };

    onMessageHandler(msg);
  }

  function matchesCron(schedule: string, date: Date): boolean {
    const fields = schedule.trim().split(/\s+/);
    if (fields.length !== 5) return false;
    const ranges: [number, number][] = [[0,59],[0,23],[1,31],[1,12],[0,6]];
    const vals = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth()+1, date.getDay()];
    return fields.every((f, i) => {
      const [min, max] = ranges[i];
      const matches = new Set<number>();
      for (const part of f.split(',')) {
        const [range, stepStr] = part.split('/');
        const step = stepStr ? parseInt(stepStr, 10) : 1;
        let lo = min, hi = max;
        if (range !== '*') {
          if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b; }
          else { lo = hi = parseInt(range, 10); }
        }
        for (let v = lo; v <= hi; v += step) matches.add(v);
      }
      return matches.has(vals[i]);
    });
  }

  function checkCronJobs(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    const now = new Date();
    for (const job of jobs.values()) {
      if (!matchesCron(job.schedule, now)) continue;
      const msg: InboundMessage = {
        id: randomUUID(),
        channel: 'scheduler',
        sender: `cron:${job.id}`,
        content: job.prompt,
        timestamp: now,
        isGroup: false,
      };
      onMessageHandler(msg);
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
