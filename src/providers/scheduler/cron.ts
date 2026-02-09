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

  function checkCronJobs(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    // Simple minute-based matching (cron expressions deferred to Phase 1)
    for (const job of jobs.values()) {
      const msg: InboundMessage = {
        id: randomUUID(),
        channel: 'scheduler',
        sender: `cron:${job.id}`,
        content: job.prompt,
        timestamp: new Date(),
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
