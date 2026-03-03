import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '../../../src/providers/scheduler/plainjob.js';
import { SQLiteJobStore, MemoryJobStore } from '../../../src/providers/scheduler/types.js';
import { openDatabase } from '../../../src/utils/sqlite.js';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';

const mockConfig = {
  profile: 'paranoid',
  providers: { memory: 'file', scanner: 'basic', channels: ['cli'], web: 'none', browser: 'none', credentials: 'keychain', skills: 'readonly', audit: 'file', sandbox: 'subprocess', scheduler: 'plainjob' },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
  },
} as Config;

// ═══════════════════════════════════════════════════════
// SQLiteJobStore unit tests
// ═══════════════════════════════════════════════════════

describe('SQLiteJobStore', () => {
  let tmpDir: string;
  let store: SQLiteJobStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-sqlite-jobstore-'));
    const db = openDatabase(join(tmpDir, 'test.db'));
    store = new SQLiteJobStore(db);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('set and get a job', () => {
    store.set({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    const job = store.get('job-1');
    expect(job).toBeDefined();
    expect(job!.id).toBe('job-1');
    expect(job!.schedule).toBe('*/5 * * * *');
    expect(job!.agentId).toBe('assistant');
    expect(job!.prompt).toBe('Check for updates');
  });

  test('get returns undefined for missing job', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  test('set overwrites existing job (upsert)', () => {
    store.set({ id: 'job-1', schedule: '* * * * *', agentId: 'a', prompt: 'v1' });
    store.set({ id: 'job-1', schedule: '*/10 * * * *', agentId: 'a', prompt: 'v2' });

    const job = store.get('job-1');
    expect(job!.schedule).toBe('*/10 * * * *');
    expect(job!.prompt).toBe('v2');
    expect(store.list()).toHaveLength(1);
  });

  test('delete removes a job and returns true', () => {
    store.set({ id: 'job-1', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
    expect(store.delete('job-1')).toBe(true);
    expect(store.get('job-1')).toBeUndefined();
  });

  test('delete returns false for missing job', () => {
    expect(store.delete('nope')).toBe(false);
  });

  test('list returns all jobs', () => {
    store.set({ id: 'j1', schedule: '* * * * *', agentId: 'a', prompt: 'p1' });
    store.set({ id: 'j2', schedule: '* * * * *', agentId: 'b', prompt: 'p2' });

    const all = store.list();
    expect(all).toHaveLength(2);
    expect(all.map(j => j.id).sort()).toEqual(['j1', 'j2']);
  });

  test('list filters by agentId', () => {
    store.set({ id: 'j1', schedule: '* * * * *', agentId: 'a', prompt: 'p1' });
    store.set({ id: 'j2', schedule: '* * * * *', agentId: 'b', prompt: 'p2' });

    expect(store.list('a')).toHaveLength(1);
    expect(store.list('a')[0].id).toBe('j1');
  });

  test('persists optional fields: maxTokenBudget, delivery, runOnce', () => {
    store.set({
      id: 'full-job',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning task',
      maxTokenBudget: 2048,
      delivery: { mode: 'channel', target: 'last' },
      runOnce: true,
    });

    const job = store.get('full-job')!;
    expect(job.maxTokenBudget).toBe(2048);
    expect(job.delivery).toEqual({ mode: 'channel', target: 'last' });
    expect(job.runOnce).toBe(true);
  });

  test('persists across database reopens', () => {
    const dbPath = join(tmpDir, 'persist.db');
    const db1 = openDatabase(dbPath);
    const store1 = new SQLiteJobStore(db1);
    store1.set({ id: 'persistent', schedule: '* * * * *', agentId: 'a', prompt: 'survives restart' });
    store1.close();

    const db2 = openDatabase(dbPath);
    const store2 = new SQLiteJobStore(db2);
    const job = store2.get('persistent');
    expect(job).toBeDefined();
    expect(job!.prompt).toBe('survives restart');
    store2.close();
  });
});

// ═══════════════════════════════════════════════════════
// PlainJob scheduler provider tests
// ═══════════════════════════════════════════════════════

describe('scheduler-plainjob', () => {
  let stopFn: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
    vi.restoreAllMocks();
  });

  // ─── Lifecycle ──────────────────────────────────────

  test('starts and stops without error', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    await scheduler.start(() => {});
    stopFn = () => scheduler.stop();
    await scheduler.stop();
    stopFn = null;
  });

  test('stop clears all timers', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    await scheduler.stop();

    const countBefore = received.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(received.length).toBe(countBefore);
  });

  // ─── CRUD ──────────────────────────────────────────

  test('addCron and listJobs', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });

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
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });

    scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    scheduler.removeCron!('job-1');
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  // ─── Heartbeat ─────────────────────────────────────

  test('heartbeat fires within active hours', async () => {
    const fastConfig = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        heartbeat_interval_min: 0.001, // ~60ms
      },
    } as Config;

    const scheduler = await create(fastConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    await new Promise((resolve) => setTimeout(resolve, 150));

    await scheduler.stop();
    stopFn = null;

    expect(received.length).toBeGreaterThan(0);
    expect(received[0].session.provider).toBe('scheduler');
    expect(received[0].session.scope).toBe('dm');
    expect(received[0].sender).toBe('heartbeat');
  });

  test('heartbeat uses default content when no HEARTBEAT.md exists', async () => {
    const fastConfig = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        heartbeat_interval_min: 0.001,
      },
    } as Config;

    const sched = await create(fastConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await sched.start(msg => received.push(msg));
    await new Promise(r => setTimeout(r, 150));
    await sched.stop();

    const hbMsg = received.find(m => m.sender === 'heartbeat');
    expect(hbMsg).toBeTruthy();
    expect(hbMsg!.content).toContain('Heartbeat check');
  });

  test('heartbeat message includes HEARTBEAT.md content when file exists', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'hb-plainjob-'));
    writeFileSync(join(agentDir, 'HEARTBEAT.md'), '# My Checks\n- check emails (every 2h)');

    const config = {
      ...mockConfig,
      scheduler: {
        ...mockConfig.scheduler,
        agent_dir: agentDir,
        heartbeat_interval_min: 0.001,
      },
    } as Config;

    const scheduler = await create(config, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start(msg => received.push(msg));
    await new Promise(r => setTimeout(r, 150));
    await scheduler.stop();

    const hbMsg = received.find(m => m.sender === 'heartbeat');
    expect(hbMsg).toBeTruthy();
    expect(hbMsg!.content).toContain('# My Checks');
    expect(hbMsg!.content).toContain('check emails');

    rmSync(agentDir, { recursive: true, force: true });
  });

  // ─── Cron matching ─────────────────────────────────

  test('cron job fires on matching minute via checkCronNow', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    scheduler.addCron!({
      id: 'test-job',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Run test task',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));

    expect(received.filter(m => m.sender === 'cron:test-job')).toHaveLength(1);
    expect(received[0].content).toBe('Run test task');
    expect(received[0].session.provider).toBe('scheduler');
  });

  test('cron job fires only once per matching minute (dedup)', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
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
    scheduler.checkCronNow!(t);
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Same minute — should NOT fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:05:30Z'));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Next minute — should fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(2);
  });

  // ─── runOnce ───────────────────────────────────────

  test('runOnce job fires once and is auto-deleted', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
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

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);

    // Job should be deleted
    expect(scheduler.listJobs!()).toHaveLength(0);

    // Next minute — should NOT fire
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);
  });

  // ─── scheduleOnce ─────────────────────────────────

  test('scheduleOnce fires job via setTimeout and auto-deletes', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50);
    scheduler.scheduleOnce!({
      id: 'once-timer',
      schedule: '* * * * *',
      agentId: 'assistant',
      prompt: 'Timed one-shot',
      runOnce: true,
    }, fireAt);

    expect(scheduler.listJobs!()).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 150));

    expect(received.filter(m => m.sender === 'cron:once-timer')).toHaveLength(1);
    expect(received[0].content).toBe('Timed one-shot');
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce: job is still in store when async handler runs', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    let jobListDuringHandler: ReturnType<NonNullable<typeof scheduler.listJobs>> = [];

    await scheduler.start(async (_msg) => {
      await new Promise(r => setTimeout(r, 10));
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

    await new Promise(r => setTimeout(r, 200));

    expect(jobListDuringHandler.some(j => j.id === 'race-test')).toBe(true);
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce job can be cancelled via removeCron', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
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

    scheduler.removeCron!('cancel-me');

    await new Promise((r) => setTimeout(r, 200));

    expect(received.filter(m => m.sender === 'cron:cancel-me')).toHaveLength(0);
    expect(scheduler.listJobs!()).toHaveLength(0);
  });

  // ─── SQLite persistence integration ───────────────

  test('jobs persist across provider recreates with SQLiteJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-persist-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Create first instance and add a job
    const db1 = openDatabase(dbPath);
    const store1 = new SQLiteJobStore(db1);
    const scheduler1 = await create(mockConfig, { jobStore: store1 });

    scheduler1.addCron!({
      id: 'persisted-job',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning standup',
    });

    await scheduler1.stop();

    // Create second instance — job should still be there
    const db2 = openDatabase(dbPath);
    const store2 = new SQLiteJobStore(db2);
    const scheduler2 = await create(mockConfig, { jobStore: store2 });

    const jobs = scheduler2.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('persisted-job');
    expect(jobs[0].prompt).toBe('Morning standup');

    await scheduler2.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removed jobs do not reappear after restart with SQLiteJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-remove-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Create, add, then remove
    const db1 = openDatabase(dbPath);
    const store1 = new SQLiteJobStore(db1);
    const scheduler1 = await create(mockConfig, { jobStore: store1 });

    scheduler1.addCron!({
      id: 'temp-job',
      schedule: '* * * * *',
      agentId: 'a',
      prompt: 'will be removed',
    });
    scheduler1.removeCron!('temp-job');
    await scheduler1.stop();

    // Reopen — should be empty
    const db2 = openDatabase(dbPath);
    const store2 = new SQLiteJobStore(db2);
    const scheduler2 = await create(mockConfig, { jobStore: store2 });

    expect(scheduler2.listJobs!()).toHaveLength(0);
    await scheduler2.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
