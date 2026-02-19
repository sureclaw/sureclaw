import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SchedulerProvider, CronJobDef } from './types.js';
import type { InboundMessage } from '../channel/types.js';
import type { ProactiveHint, MemoryProvider } from '../memory/types.js';
import type { AuditProvider } from '../audit/types.js';
import type { Config } from '../../types.js';
import {
  type ActiveHours,
  schedulerSession, parseTime, isWithinActiveHours, matchesCron,
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

  function checkCronJobs(at?: Date): void {
    if (!onMessageHandler) return;
    if (!isWithinActiveHours(activeHours)) return;

    const now = at ?? new Date();

    for (const job of jobs.values()) {
      if (matchesCron(job.schedule, now)) {
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
