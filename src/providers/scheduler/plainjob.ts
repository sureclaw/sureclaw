import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef, JobStore } from './types.js';
import { KyselyJobStore } from '../../job-store.js';
import type { InboundMessage } from '../shared-types.js';
import type { Config } from '../../types.js';
import type { DatabaseProvider } from '../database/types.js';
import type { EventBusProvider } from '../eventbus/types.js';
import type { ProactiveHint } from '../memory/types.js';
import { createKyselyDb } from '../../utils/database.js';
import { runMigrations } from '../../utils/migrator.js';
import { buildJobsMigrations } from '../../migrations/jobs.js';
import { dataDir, dataFile } from '../../paths.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron, minuteKey,
} from './utils.js';

interface PlainJobSchedulerDeps {
  jobStore?: JobStore;
  database?: DatabaseProvider;
  eventbus?: EventBusProvider;
}

export async function create(config: Config, deps: PlainJobSchedulerDeps = {}): Promise<SchedulerProvider> {
  let jobs: JobStore;

  if (deps.jobStore) {
    jobs = deps.jobStore;
  } else if (deps.database) {
    const result = await runMigrations(deps.database.db, buildJobsMigrations(deps.database.type), 'scheduler_migration');
    if (result.error) throw result.error;
    jobs = new KyselyJobStore(deps.database.db);
  } else {
    // Standalone fallback: create own Kysely instance
    mkdirSync(dataDir(), { recursive: true });
    const db = createKyselyDb({ type: 'sqlite', path: dataFile('scheduler.db') });
    const result = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
    if (result.error) throw result.error;
    jobs = new KyselyJobStore(db);
  }

  // Ensure synthetic heartbeat row exists for distributed dedup (KyselyJobStore only)
  const agentName = config.agent_name;
  const HEARTBEAT_JOB_ID = `__heartbeat__:${agentName}`;
  if (jobs instanceof KyselyJobStore) {
    const existing = await jobs.get(HEARTBEAT_JOB_ID);
    if (!existing) {
      await jobs.set({
        id: HEARTBEAT_JOB_ID,
        schedule: '* * * * *', // not used for matching — heartbeat uses its own interval
        agentId: agentName,
        prompt: '', // not used
      });
    }
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
  // Track jobs currently executing — skip firing if a previous invocation hasn't finished
  const inFlight = new Set<string>();
  // Closed flag to guard deferred cleanup against closed DB
  let stopped = false;

  const activeHours: ActiveHours = {
    start: parseTime(config.scheduler.active_hours.start),
    end: parseTime(config.scheduler.active_hours.end),
    timezone: config.scheduler.active_hours.timezone,
  };

  const heartbeatIntervalMs = config.scheduler.heartbeat_interval_min * 60 * 1000;
  const agentDir = config.scheduler.agent_dir;

  // ─── Proactive hint gating ─────────────────────────
  const confidenceThreshold = config.scheduler.proactive_hint_confidence_threshold ?? 0.7;
  const cooldownSec = config.scheduler.proactive_hint_cooldown_sec ?? 1800;
  const cooldownMap = new Map<string, number>();
  let unsubscribeHints: (() => void) | null = null;

  function hintSignature(hint: ProactiveHint): string {
    return createHash('sha256')
      .update(`${hint.kind}:${hint.scope}:${hint.suggestedPrompt}`)
      .digest('hex')
      .slice(0, 16);
  }

  function handleProactiveHint(hint: ProactiveHint): void {
    if (!onMessageHandler) return;
    if (hint.confidence < confidenceThreshold) return;
    if (!isWithinActiveHours(activeHours)) return;

    const sig = hintSignature(hint);
    const lastFired = cooldownMap.get(sig);
    if (lastFired !== undefined) {
      const elapsed = (Date.now() - lastFired) / 1000;
      if (elapsed < cooldownSec) return;
    }

    cooldownMap.set(sig, Date.now());

    onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`hint:${hint.kind}`, agentName),
      sender: `hint:${hint.kind}`,
      content: hint.suggestedPrompt,
      attachments: [],
      timestamp: new Date(),
    });
  }

  function fireHeartbeat(): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;
    // Skip if previous heartbeat is still executing
    if (inFlight.has(HEARTBEAT_JOB_ID)) return;

    // Distributed dedup: claim the heartbeat slot for this minute
    if (jobs.tryClaim) {
      const mk = minuteKey(new Date());
      const claimed = jobs.tryClaim(HEARTBEAT_JOB_ID, mk);
      // tryClaim may return a Promise (KyselyJobStore) — handle both
      if (claimed && typeof (claimed as any).then === 'function') {
        (claimed as Promise<boolean>).then(
          ok => { if (ok) emitHeartbeat(); },
          err => { /* tryClaim rejected — skip this heartbeat tick */ void err; },
        );
        return;
      }
      if (!claimed) return;
    }

    emitHeartbeat();
  }

  function emitHeartbeat(): void {
    if (!onMessageHandler) return;

    let content = 'Heartbeat check — review pending tasks and proactive hints.';
    if (agentDir) {
      try {
        const md = readFileSync(join(agentDir, 'HEARTBEAT.md'), 'utf-8');
        if (md.trim()) content = md;
      } catch { /* no HEARTBEAT.md — use default */ }
    }

    inFlight.add(HEARTBEAT_JOB_ID);
    let result: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = (onMessageHandler as any)({
        id: randomUUID(),
        session: schedulerSession('heartbeat', agentName),
        sender: 'heartbeat',
        content,
        attachments: [],
        timestamp: new Date(),
      });
    } catch {
      inFlight.delete(HEARTBEAT_JOB_ID);
      return;
    }
    if (result && typeof (result as Promise<unknown>).then === 'function') {
      (result as Promise<unknown>).finally(() => inFlight.delete(HEARTBEAT_JOB_ID));
    } else {
      inFlight.delete(HEARTBEAT_JOB_ID);
    }
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

    // Distributed dedup: claim via DB before firing
    if (jobs.tryClaim) {
      const mk = `once:${job.id}`;
      const claimed = jobs.tryClaim(job.id, mk);
      if (claimed && typeof (claimed as any).then === 'function') {
        (claimed as Promise<boolean>).then(
          ok => {
            if (ok) doFireOnce(job);
            else {
              // Another replica already fired — just clean up local timer
              onceTimers.delete(job.id);
            }
          },
          err => { /* tryClaim rejected — skip this once-job */ void err; },
        );
        return;
      }
      if (!claimed) {
        onceTimers.delete(job.id);
        return;
      }
    }

    doFireOnce(job);
  }

  function doFireOnce(job: CronJobDef): void {
    if (!onMessageHandler) return;
    let result: unknown;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      result = (onMessageHandler as any)({
        id: randomUUID(),
        session: schedulerSession(`cron:${job.id}`, job.agentId),
        sender: `cron:${job.id}`,
        content: job.prompt,
        attachments: [],
        timestamp: new Date(),
      });
    } catch {
      // Synchronous throw — still clean up job so it doesn't re-fire
      jobs.delete(job.id);
      onceTimers.delete(job.id);
      return;
    }
    deferCleanup(result, () => {
      jobs.delete(job.id);
      onceTimers.delete(job.id);
    });
  }

  async function checkCronJobs(at?: Date): Promise<void> {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;
    const now = at ?? new Date();
    const mk = minuteKey(now);
    const jobList = await jobs.list();
    for (const job of jobList) {
      if (job.id.startsWith('__heartbeat__:')) continue; // synthetic row for heartbeat dedup
      if (!matchesCron(job.schedule, now)) continue;

      // Skip if this job is still executing from a previous fire
      if (inFlight.has(job.id)) continue;

      // Distributed dedup: use tryClaim if available (KyselyJobStore),
      // fall back to in-memory map (MemoryJobStore without tryClaim).
      if (jobs.tryClaim) {
        const claimed = await jobs.tryClaim(job.id, mk);
        if (!claimed) continue;
      } else {
        if (lastFiredMinute.get(job.id) === mk) continue;
        lastFiredMinute.set(job.id, mk);
      }

      inFlight.add(job.id);
      let result: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        result = (onMessageHandler as any)({
          id: randomUUID(),
          session: schedulerSession(`cron:${job.id}`, job.agentId),
          sender: `cron:${job.id}`,
          content: job.prompt,
          attachments: [],
          timestamp: now,
        });
      } catch {
        inFlight.delete(job.id);
        continue;
      }
      // Clear in-flight when completion finishes (or immediately if sync)
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).finally(() => inFlight.delete(job.id));
      } else {
        inFlight.delete(job.id);
      }
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
      if (jobs instanceof KyselyJobStore) {
        const now = Date.now();
        const withRunAt = await jobs.listWithRunAt();
        for (const { job, runAt } of withRunAt) {
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

      // Subscribe to proactive hints from event bus
      if (deps.eventbus) {
        unsubscribeHints = deps.eventbus.subscribe((event) => {
          if (event.type !== 'memory.proactive_hint') return;
          handleProactiveHint(event.data as unknown as ProactiveHint);
        });
      }
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
      if (unsubscribeHints) {
        unsubscribeHints();
        unsubscribeHints = null;
      }
      for (const timer of onceTimers.values()) clearTimeout(timer);
      onceTimers.clear();
      onMessageHandler = null;
      // Wait for in-flight async cleanups before closing the DB
      if (pendingCleanups.size > 0) {
        await Promise.allSettled([...pendingCleanups]);
      }
      stopped = true;
      await jobs.close();
    },

    async addCron(job: CronJobDef): Promise<void> {
      await jobs.set(job);
    },

    async removeCron(jobId: string): Promise<void> {
      const timer = onceTimers.get(jobId);
      if (timer) {
        clearTimeout(timer);
        onceTimers.delete(jobId);
      }
      await jobs.delete(jobId);
    },

    async listJobs(agentId?: string): Promise<CronJobDef[]> {
      const all = await jobs.list(agentId);
      return all.filter(j => !j.id.startsWith('__heartbeat__:'));
    },

    async scheduleOnce(job: CronJobDef, fireAt: Date): Promise<void> {
      await jobs.set(job);
      // Persist fire time so one-shot jobs survive restarts
      if (jobs instanceof KyselyJobStore) {
        await jobs.setRunAt(job.id, fireAt);
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
