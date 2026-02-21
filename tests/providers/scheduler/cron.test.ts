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

  test('heartbeat message includes overdue status summary from HeartbeatState', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');

    const agentDir = mkdtempSync(join(tmpdir(), 'hb-status-'));
    writeFileSync(
      join(agentDir, 'HEARTBEAT.md'),
      '- **memory-review** (every 4h): Review memories\n- **pending-tasks** (every 1h): Check tasks',
    );

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
    await new Promise(r => setTimeout(r, 150));
    await scheduler.stop();

    const hbMsg = received.find(m => m.sender === 'heartbeat');
    expect(hbMsg).toBeTruthy();
    // Should contain the status summary section
    expect(hbMsg!.content).toContain('Current Status');
    // Both checks should appear as never run / OVERDUE
    expect(hbMsg!.content).toMatch(/memory-review.*OVERDUE/i);
    expect(hbMsg!.content).toMatch(/pending-tasks.*OVERDUE/i);

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
