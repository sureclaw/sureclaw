import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef, JobStore } from './types.js';
import { MemoryJobStore } from './types.js';
import type { InboundMessage } from '../channel/types.js';
import type { ProactiveHint, MemoryProvider } from '../memory/types.js';
import type { AuditProvider } from '../audit/types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron, minuteKey,
} from './utils.js';

function hintSignature(hint: ProactiveHint): string {
  return createHash('sha256')
    .update(`${hint.kind}:${hint.scope}:${hint.suggestedPrompt}`)
    .digest('hex')
    .slice(0, 16);
}

// ═══════════════════════════════════════════════════════
// Full scheduler provider
// ═══════════════════════════════════════════════════════

interface FullSchedulerDeps {
  audit?: AuditProvider;
  memory?: MemoryProvider;
  jobStore?: JobStore;
}

export async function create(
  config: Config,
  deps: FullSchedulerDeps = {},
): Promise<SchedulerProvider> {
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
  const confidenceThreshold = config.scheduler.proactive_hint_confidence_threshold ?? 0.7;
  const cooldownSec = config.scheduler.proactive_hint_cooldown_sec ?? 1800;
  const maxTokenBudget = config.scheduler.max_token_budget;
  const agentDir = config.scheduler.agent_dir;

  // Cooldown tracking: signature → timestamp of last fire
  const cooldownMap = new Map<string, number>();

  // Token budget tracking
  let tokensUsed = 0;

  // Queued hints (when budget exceeded)
  const pendingHints: ProactiveHint[] = [];

  // ─── Internal helpers ─────────────────────────────

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`cron:${job.id}`),
      sender: `cron:${job.id}`,
      content: job.prompt,
      attachments: [],
      timestamp: new Date(),
    });
    // Defer cleanup until after async handler completes so the handler can
    // still look up the job in the store (e.g., for delivery resolution).
    // Sync handlers clean up immediately.
    const cleanup = () => {
      jobs.delete(job.id);
      onceTimers.delete(job.id);
    };
    if (result?.then) {
      result.then(cleanup, cleanup);
    } else {
      cleanup();
    }
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
        // Defer cleanup until after async handler so it can still look up the job.
        const runOnceCleanup = () => {
          jobs.delete(job.id);
          lastFiredMinute.delete(job.id);
        };
        if (result?.then) {
          result.then(runOnceCleanup, runOnceCleanup);
        } else {
          runOnceCleanup();
        }
      }
    }
  }

  async function logAudit(action: string, args: Record<string, unknown>): Promise<void> {
    if (!deps.audit) return;
    await deps.audit.log({
      action,
      args,
      sessionId: 'scheduler',
      result: 'success',
      timestamp: new Date(),
      durationMs: 0,
    });
  }

  function handleProactiveHint(hint: ProactiveHint): void {
    if (!onMessageHandler) return;

    const sig = hintSignature(hint);

    // Check confidence threshold
    if (hint.confidence < confidenceThreshold) {
      logAudit('hint_suppressed', {
        kind: hint.kind,
        confidence: hint.confidence,
        reason: `Below confidence threshold (${hint.confidence} < ${confidenceThreshold})`,
      });
      return;
    }

    // Check active hours
    if (!isWithinActiveHours(activeHours)) {
      logAudit('hint_suppressed', {
        kind: hint.kind,
        confidence: hint.confidence,
        reason: 'Outside active hours',
      });
      return;
    }

    // Check cooldown
    const lastFired = cooldownMap.get(sig);
    if (lastFired !== undefined) {
      const elapsed = (Date.now() - lastFired) / 1000;
      if (elapsed < cooldownSec) {
        logAudit('hint_suppressed', {
          kind: hint.kind,
          confidence: hint.confidence,
          reason: `Within cooldown (${elapsed.toFixed(0)}s < ${cooldownSec}s)`,
          signature: sig,
        });
        return;
      }
    }

    // Check token budget
    if (tokensUsed >= maxTokenBudget) {
      pendingHints.push(hint);
      logAudit('hint_suppressed', {
        kind: hint.kind,
        confidence: hint.confidence,
        reason: `Token budget exceeded (${tokensUsed} >= ${maxTokenBudget})`,
      });
      return;
    }

    // Fire the hint
    cooldownMap.set(sig, Date.now());

    logAudit('hint_fired', {
      kind: hint.kind,
      confidence: hint.confidence,
      scope: hint.scope,
      source: hint.source,
      signature: sig,
    });

    onMessageHandler({
      id: randomUUID(),
      session: schedulerSession(`hint:${hint.kind}`),
      sender: `hint:${hint.kind}`,
      content: hint.suggestedPrompt,
      attachments: [],
      timestamp: new Date(),
    });
  }

  // ─── Wire memory provider hint subscription ───────

  if (deps.memory?.onProactiveHint) {
    deps.memory.onProactiveHint(handleProactiveHint);
  }

  // ─── Provider implementation ──────────────────────

  return {
    async start(onMessage: (msg: InboundMessage) => void): Promise<void> {
      onMessageHandler = onMessage;
      heartbeatTimer = setInterval(fireHeartbeat, heartbeatIntervalMs);
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

    checkCronNow(at?: Date): void {
      checkCronJobs(at);
    },

    scheduleOnce(job: CronJobDef, fireAt: Date): void {
      jobs.set(job);
      const delayMs = Math.max(0, fireAt.getTime() - Date.now());
      const timer = setTimeout(() => fireOnceJob(job), delayMs);
      onceTimers.set(job.id, timer);
    },

    recordTokenUsage(tokens: number): void {
      tokensUsed += tokens;
    },

    listPendingHints(): ProactiveHint[] {
      return [...pendingHints];
    },
  };
}
