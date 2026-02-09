import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type {
  SchedulerProvider,
  InboundMessage,
  CronJobDef,
  Config,
  ProactiveHint,
  AuditProvider,
  MemoryProvider,
} from '../types.js';

// ═══════════════════════════════════════════════════════
// Cron expression matching
// ═══════════════════════════════════════════════════════

/**
 * Parse a single cron field (minute, hour, dom, month, dow).
 * Supports: *, N, N-M, *​/N, N-M/N, comma-separated lists.
 * Returns a Set of matching values within [min, max].
 */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();

  for (const part of field.split(',')) {
    const stepParts = part.split('/');
    const range = stepParts[0];
    const step = stepParts[1] ? parseInt(stepParts[1], 10) : 1;

    let start = min;
    let end = max;

    if (range === '*') {
      // already defaults
    } else if (range.includes('-')) {
      const [lo, hi] = range.split('-').map(Number);
      start = lo;
      end = hi;
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    for (let i = start; i <= end; i += step) {
      result.add(i);
    }
  }

  return result;
}

/**
 * Check if the given Date matches a standard 5-field cron expression.
 * Fields: minute hour day-of-month month day-of-week
 */
function matchesCron(schedule: string, date: Date): boolean {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1; // 1-12
  const dow = date.getDay(); // 0=Sun

  const [minF, hourF, domF, monthF, dowF] = fields;

  return (
    parseCronField(minF, 0, 59).has(minute) &&
    parseCronField(hourF, 0, 23).has(hour) &&
    parseCronField(domF, 1, 31).has(dom) &&
    parseCronField(monthF, 1, 12).has(month) &&
    parseCronField(dowF, 0, 6).has(dow)
  );
}

// ═══════════════════════════════════════════════════════
// Active hours check
// ═══════════════════════════════════════════════════════

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
  const timeStr = now.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    timeZone: hours.timezone,
  });
  const currentMinutes = parseTime(timeStr);
  return currentMinutes >= hours.start && currentMinutes < hours.end;
}

// ═══════════════════════════════════════════════════════
// Hint signature for cooldown dedup
// ═══════════════════════════════════════════════════════

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
}

export async function create(
  config: Config,
  deps: FullSchedulerDeps = {},
): Promise<SchedulerProvider> {
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
  const confidenceThreshold = config.scheduler.proactive_hint_confidence_threshold ?? 0.7;
  const cooldownSec = config.scheduler.proactive_hint_cooldown_sec ?? 1800;
  const maxTokenBudget = config.scheduler.max_token_budget;

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

    onMessageHandler({
      id: randomUUID(),
      channel: 'scheduler',
      sender: 'heartbeat',
      content: 'Heartbeat check — review pending tasks and proactive hints.',
      timestamp: new Date(),
      isGroup: false,
    });
  }

  function checkCronJobs(at?: Date): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    const now = at ?? new Date();

    for (const job of jobs.values()) {
      if (matchesCron(job.schedule, now)) {
        onMessageHandler({
          id: randomUUID(),
          channel: 'scheduler',
          sender: `cron:${job.id}`,
          content: job.prompt,
          timestamp: now,
          isGroup: false,
        });
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
      channel: 'scheduler',
      sender: `hint:${hint.kind}`,
      content: hint.suggestedPrompt,
      timestamp: new Date(),
      isGroup: false,
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

    checkCronNow(at?: Date): void {
      checkCronJobs(at);
    },

    recordTokenUsage(tokens: number): void {
      tokensUsed += tokens;
    },

    listPendingHints(): ProactiveHint[] {
      return [...pendingHints];
    },
  };
}
