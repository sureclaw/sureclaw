import { describe, test, expect, afterEach, vi } from 'vitest';
import { create } from '../../../src/providers/scheduler/full.js';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';
import type { ProactiveHint, MemoryProvider } from '../../../src/providers/memory/types.js';
import type { AuditProvider } from '../../../src/providers/audit/types.js';

// ─── Mock config ──────────────────────────────────────

const mockConfig = {
  profile: 'balanced',
  providers: {
    llm: 'anthropic', memory: 'file', scanner: 'basic',
    channels: ['cli'], web: 'none', browser: 'none',
    credentials: 'env', skills: 'readonly', audit: 'file',
    sandbox: 'subprocess', scheduler: 'full',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
    proactive_hint_confidence_threshold: 0.7,
    proactive_hint_cooldown_sec: 1800,
  },
} as Config;

// ─── Mock audit provider ──────────────────────────────

function createMockAudit(): AuditProvider & { entries: any[] } {
  const entries: any[] = [];
  return {
    entries,
    async log(entry) { entries.push(entry); },
    async query() { return []; },
  };
}

// ─── Mock memory provider with hint subscription ──────

function createMockMemory(): MemoryProvider & { fireHint: (h: ProactiveHint) => void } {
  let handler: ((h: ProactiveHint) => void) | null = null;
  return {
    async write() { return 'id'; },
    async query() { return []; },
    async read() { return null; },
    async delete() {},
    async list() { return []; },
    onProactiveHint(h: (hint: ProactiveHint) => void) { handler = h; },
    fireHint(h: ProactiveHint) {
      if (handler) handler(h);
    },
  };
}

// ─── Helpers ──────────────────────────────────────────

function makeHint(overrides: Partial<ProactiveHint> = {}): ProactiveHint {
  return {
    source: 'memory',
    kind: 'pending_task',
    reason: 'You have a pending task',
    suggestedPrompt: 'Check pending tasks',
    confidence: 0.85,
    scope: 'tasks',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════

describe('scheduler-full', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
    vi.restoreAllMocks();
  });

  // ─── Cron expression matching ──────────────────────

  test('cron job fires when schedule matches current minute', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    // Add a job with "every minute" schedule
    scheduler.addCron!({
      id: 'every-min',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Run every minute',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Manually trigger cron check
    scheduler.checkCronNow!();

    expect(received.some(m => m.sender === 'cron:every-min')).toBe(true);
    expect(received.find(m => m.sender === 'cron:every-min')!.content).toBe('Run every minute');
  });

  test('cron job does NOT fire when schedule does not match', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    // A schedule that will likely not match the current minute
    // Use a specific minute in the past to avoid matching
    const now = new Date();
    const otherMinute = (now.getMinutes() + 30) % 60;

    scheduler.addCron!({
      id: 'specific-min',
      schedule: `${otherMinute} 25 31 12 *`, // Dec 31 at 25:xx — never matches
      agentId: 'assistant',
      prompt: 'Should not fire',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!();

    expect(received.filter(m => m.sender === 'cron:specific-min')).toHaveLength(0);
  });

  test('cron expression "*/5 * * * *" matches every 5 minutes', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    scheduler.addCron!({
      id: 'every-5',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Every 5 min',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Pass a date that matches */5 (minute 0)
    scheduler.checkCronNow!(new Date('2026-02-08T12:00:00Z'));

    const matches = received.filter(m => m.sender === 'cron:every-5');
    expect(matches.length).toBe(1);

    // Now check minute 3 — should not match
    received.length = 0;
    scheduler.checkCronNow!(new Date('2026-02-08T12:03:00Z'));

    expect(received.filter(m => m.sender === 'cron:every-5')).toHaveLength(0);
  });

  test('runOnce job fires once and is auto-deleted', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    scheduler.addCron!({
      id: 'once-job',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Run once only',
      runOnce: true,
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // First check — should fire
    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);

    // Job should be deleted
    expect(scheduler.listJobs!()).toHaveLength(0);

    // Next minute — should NOT fire (job was removed)
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);
  });

  test('cron job fires only once per matching minute (no duplicate on re-check)', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    scheduler.addCron!({
      id: 'dedup-job',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Should fire once',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const t = new Date('2026-03-01T12:05:00Z');

    // First check — should fire
    scheduler.checkCronNow!(t);
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Second check same minute — should NOT fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:05:30Z'));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Next minute — should fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(2);
  });

  // ─── scheduleOnce (setTimeout-based one-shot) ──────

  test('scheduleOnce fires job via setTimeout and auto-deletes', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50); // 50ms from now
    scheduler.scheduleOnce!({
      id: 'once-timer',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Timed one-shot',
      runOnce: true,
    }, fireAt);

    // Job should be listed before firing
    expect(scheduler.listJobs!()).toHaveLength(1);

    // Wait for the timer to fire
    await new Promise((r) => setTimeout(r, 150));

    expect(received.filter(m => m.sender === 'cron:once-timer')).toHaveLength(1);
    expect(received[0].content).toBe('Timed one-shot');

    // Job should be auto-deleted after firing
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce: job is still in store when async handler runs', async () => {
    const scheduler = await create(mockConfig);
    let jobListDuringHandler: ReturnType<NonNullable<typeof scheduler.listJobs>> = [];

    // Use an async handler (like the real server handler) that yields before checking the job store
    await scheduler.start(async (_msg) => {
      await new Promise(r => setTimeout(r, 10)); // yield to event loop
      jobListDuringHandler = scheduler.listJobs!();
    });
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50);
    scheduler.scheduleOnce!({
      id: 'race-test',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Race condition test',
      runOnce: true,
    }, fireAt);

    // Wait for timer to fire and async handler to complete
    await new Promise(r => setTimeout(r, 200));

    // The handler should have been able to find the job (not yet deleted)
    expect(jobListDuringHandler.some(j => j.id === 'race-test')).toBe(true);

    // But after handler completes, job should be cleaned up
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce job can be cancelled via removeCron', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 100);
    scheduler.scheduleOnce!({
      id: 'cancel-me',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Should not fire',
      runOnce: true,
    }, fireAt);

    // Cancel before it fires
    scheduler.removeCron!('cancel-me');

    await new Promise((r) => setTimeout(r, 200));

    expect(received.filter(m => m.sender === 'cron:cancel-me')).toHaveLength(0);
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  // ─── ProactiveHint bridge ──────────────────────────

  test('hint with sufficient confidence fires as InboundMessage', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const scheduler = await create(mockConfig, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    memory.fireHint(makeHint({ confidence: 0.85 }));

    // Should have generated an InboundMessage
    const hintMsg = received.find(m => m.session.provider === 'scheduler' && m.sender.startsWith('hint:'));
    expect(hintMsg).toBeTruthy();
    expect(hintMsg!.content).toContain('Check pending tasks');
  });

  test('hint below confidence threshold is suppressed', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const scheduler = await create(mockConfig, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    memory.fireHint(makeHint({ confidence: 0.5 }));

    const hintMsgs = received.filter(m => m.sender.startsWith('hint:'));
    expect(hintMsgs).toHaveLength(0);

    // Should be logged as suppressed
    const suppressed = audit.entries.find(e => e.action === 'hint_suppressed');
    expect(suppressed).toBeTruthy();
    expect(suppressed.args.reason).toContain('confidence');
  });

  test('duplicate hint within cooldown is suppressed', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    // Short cooldown for testing
    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        proactive_hint_cooldown_sec: 2, // 2 seconds
      },
    } as Config;
    const scheduler = await create(config, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // First hint fires
    memory.fireHint(makeHint());
    expect(received.filter(m => m.sender.startsWith('hint:')).length).toBe(1);

    // Second identical hint within cooldown is suppressed
    memory.fireHint(makeHint());
    expect(received.filter(m => m.sender.startsWith('hint:')).length).toBe(1);

    const cooldownEntry = audit.entries.find(e =>
      e.action === 'hint_suppressed' && e.args?.reason?.includes('cooldown')
    );
    expect(cooldownEntry).toBeTruthy();
  });

  test('hint after cooldown expires fires again', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        proactive_hint_cooldown_sec: 0.1, // 100ms
      },
    } as Config;
    const scheduler = await create(config, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // First hint
    memory.fireHint(makeHint());
    expect(received.filter(m => m.sender.startsWith('hint:')).length).toBe(1);

    // Wait for cooldown to expire
    await new Promise(r => setTimeout(r, 150));

    // Same hint fires again
    memory.fireHint(makeHint());
    expect(received.filter(m => m.sender.startsWith('hint:')).length).toBe(2);
  });

  test('hint outside active hours is suppressed', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    // Active hours set to a 1-minute window far from any reasonable test time
    // This ensures the hint is always outside active hours
    const now = new Date();
    const currentHour = now.getUTCHours();
    // Pick an hour that's at least 2 hours away from current
    const farHour = (currentHour + 12) % 24;
    const farStart = `${String(farHour).padStart(2, '0')}:00`;
    const farEnd = `${String(farHour).padStart(2, '0')}:01`;

    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        active_hours: { start: farStart, end: farEnd, timezone: 'UTC' },
      },
    } as Config;

    const scheduler = await create(config, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    memory.fireHint(makeHint());

    const hintMsgs = received.filter(m => m.sender.startsWith('hint:'));
    expect(hintMsgs).toHaveLength(0);

    const suppressed = audit.entries.find(e =>
      e.action === 'hint_suppressed' && e.args?.reason?.includes('active hours')
    );
    expect(suppressed).toBeTruthy();
  });

  test('hint suppressed when token budget exceeded', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        max_token_budget: 100, // Very low budget
      },
    } as Config;
    const scheduler = await create(config, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Exhaust token budget
    scheduler.recordTokenUsage!(150);

    // Now a hint should be suppressed
    memory.fireHint(makeHint());

    const hintMsgs = received.filter(m => m.sender.startsWith('hint:'));
    expect(hintMsgs).toHaveLength(0);

    const suppressed = audit.entries.find(e =>
      e.action === 'hint_suppressed' && e.args?.reason?.includes('budget')
    );
    expect(suppressed).toBeTruthy();
  });

  test('fired hints are logged to audit', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const scheduler = await create(mockConfig, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    memory.fireHint(makeHint());

    const fired = audit.entries.find(e => e.action === 'hint_fired');
    expect(fired).toBeTruthy();
    expect(fired.args.kind).toBe('pending_task');
    expect(fired.args.confidence).toBe(0.85);
  });

  // ─── CRUD / lifecycle ─────────────────────────────

  test('addCron, listJobs, removeCron work', async () => {
    const scheduler = await create(mockConfig);

    scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check updates',
    });

    expect(scheduler.listJobs!()).toHaveLength(1);

    scheduler.removeCron!('job-1');
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('start and stop lifecycle', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    await scheduler.stop();
    // Should not throw
  });

  test('stop clears all timers and no more messages fire', async () => {
    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        heartbeat_interval_min: 0.001, // ~60ms
      },
    } as Config;
    const scheduler = await create(config);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    await scheduler.stop();

    const countAfterStop = received.length;
    await new Promise(r => setTimeout(r, 200));
    expect(received.length).toBe(countAfterStop);
  });

  // ─── listPendingHints ─────────────────────────────

  test('listPendingHints returns queued hints when budget exceeded', async () => {
    const audit = createMockAudit();
    const memory = createMockMemory();
    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        max_token_budget: 100,
      },
    } as Config;
    const scheduler = await create(config, { audit, memory });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Exhaust budget
    scheduler.recordTokenUsage!(150);

    // This hint gets queued, not fired
    memory.fireHint(makeHint({ suggestedPrompt: 'Queued hint' }));

    const pending = scheduler.listPendingHints!();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].suggestedPrompt).toBe('Queued hint');
  });

  // ─── HEARTBEAT.md injection ─────────────────────

  test('heartbeat message includes HEARTBEAT.md content when file exists', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const agentDir = mkdtempSync(join(tmpdir(), 'hb-sched-'));
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# My Checks\n- check emails (every 2h)');

    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        agent_dir: agentDir,
        heartbeat_interval_min: 0.001,
      },
    } as Config;

    const scheduler = await create(config);
    const received: InboundMessage[] = [];

    await scheduler.start(msg => received.push(msg));

    // Wait for heartbeat to fire
    await new Promise(r => setTimeout(r, 150));
    await scheduler.stop();

    const hbMsg = received.find(m => m.sender === 'heartbeat');
    expect(hbMsg).toBeTruthy();
    expect(hbMsg!.content).toContain('# My Checks');
    expect(hbMsg!.content).toContain('check emails');

    rmSync(agentDir, { recursive: true, force: true });
  });

  test('heartbeat uses default content when no HEARTBEAT.md exists', async () => {
    const fastConfig = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        heartbeat_interval_min: 0.001,
      },
    } as Config;

    const sched = await create(fastConfig);
    const received: InboundMessage[] = [];

    await sched.start(msg => received.push(msg));
    await new Promise(r => setTimeout(r, 150));
    await sched.stop();

    const hbMsg = received.find(m => m.sender === 'heartbeat');
    expect(hbMsg).toBeTruthy();
    expect(hbMsg!.content).toContain('Heartbeat check');
  });
});
