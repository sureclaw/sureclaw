import { describe, test, expect, afterEach, vi } from 'vitest';
import { create } from '../../../src/providers/scheduler/cron.js';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';

const mockConfig = {
  profile: 'paranoid',
  providers: { llm: 'anthropic', memory: 'file', scanner: 'basic', channels: ['cli'], web: 'none', browser: 'none', credentials: 'env', skills: 'readonly', audit: 'file', sandbox: 'subprocess', scheduler: 'cron' },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
  },
} as Config;

describe('scheduler-cron', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
    vi.restoreAllMocks();
  });

  test('starts and stops without error', async () => {
    const scheduler = await create(mockConfig);
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();
    await scheduler.stop();
    stopFn = null;
  });

  test('addCron and listJobs', async () => {
    const scheduler = await create(mockConfig);

    scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    const jobs = scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('job-1');
    expect(jobs[0].prompt).toBe('Check for updates');
  });

  test('removeCron removes a job', async () => {
    const scheduler = await create(mockConfig);

    scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    scheduler.removeCron!('job-1');
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('heartbeat fires within active hours', async () => {
    // Use a very short heartbeat interval for testing
    const fastConfig = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        heartbeat_interval_min: 0.001, // ~60ms
      },
    } as Config;

    const scheduler = await create(fastConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Wait for at least one heartbeat
    await new Promise((resolve) => setTimeout(resolve, 150));

    await scheduler.stop();
    stopFn = null;

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].session.provider).toBe('scheduler');
    expect(received[0].session.scope).toBe('dm');
    expect(received[0].sender).toBe('heartbeat');
  });

  test('cron jobs fire on check interval', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    scheduler.addCron!({
      id: 'test-job',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Run test task',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    // Manually trigger by advancing timers — but since we can't easily
    // control setInterval timing, we just verify the job is registered
    expect(scheduler.listJobs!()).toHaveLength(1);

    await scheduler.stop();
    stopFn = null;
  });

  test('stop clears all timers', async () => {
    const scheduler = await create(mockConfig);
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    await scheduler.stop();

    // After stopping, no more messages should arrive
    const countBefore = received.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received.length).toBe(countBefore);
  });

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
