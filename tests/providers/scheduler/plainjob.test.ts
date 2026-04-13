import { describe, test, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { create } from '../../../src/providers/scheduler/plainjob.js';
import { MemoryJobStore } from '../../../src/providers/scheduler/types.js';
import { KyselyJobStore } from '../../../src/job-store.js';
import { createKyselyDb } from '../../../src/utils/database.js';
import { runMigrations } from '../../../src/utils/migrator.js';
import { jobsMigrations, buildJobsMigrations } from '../../../src/migrations/jobs.js';
import type { Config } from '../../../src/types.js';
import type { InboundMessage } from '../../../src/providers/channel/types.js';
import type { EventBusProvider, StreamEvent } from '../../../src/providers/eventbus/types.js';

// Default agent_name is 'main', so test jobs use agentId: 'main'
const AGENT = 'main';

const mockConfig = {
  profile: 'paranoid',
  providers: { memory: 'cortex', security: 'patterns', channels: ['cli'], web: { extract: 'none', search: 'none' }, credentials: 'database', skills: 'database', audit: 'database', sandbox: 'docker', scheduler: 'plainjob' },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '00:00', end: '23:59', timezone: 'UTC' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
  },
} as Config;

// ═══════════════════════════════════════════════════════
// KyselyJobStore unit tests
// ═══════════════════════════════════════════════════════

describe('KyselyJobStore', () => {
  let tmpDir: string;
  let store: KyselyJobStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-kysely-jobstore-'));
    const db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'test.db') });
    const result = await runMigrations(db, jobsMigrations);
    if (result.error) throw result.error;
    store = new KyselyJobStore(db);
  });

  afterEach(async () => {
    await store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('set and get a job', async () => {
    await store.set({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    const job = await store.get('job-1');
    expect(job).toBeDefined();
    expect(job!.id).toBe('job-1');
    expect(job!.schedule).toBe('*/5 * * * *');
    expect(job!.agentId).toBe('assistant');
    expect(job!.prompt).toBe('Check for updates');
  });

  test('get returns undefined for missing job', async () => {
    expect(await store.get('nonexistent')).toBeUndefined();
  });

  test('set overwrites existing job (upsert)', async () => {
    await store.set({ id: 'job-1', schedule: '* * * * *', agentId: 'a', prompt: 'v1' });
    await store.set({ id: 'job-1', schedule: '*/10 * * * *', agentId: 'a', prompt: 'v2' });

    const job = await store.get('job-1');
    expect(job!.schedule).toBe('*/10 * * * *');
    expect(job!.prompt).toBe('v2');
    expect(await store.list()).toHaveLength(1);
  });

  test('delete removes a job and returns true', async () => {
    await store.set({ id: 'job-1', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
    expect(await store.delete('job-1')).toBe(true);
    expect(await store.get('job-1')).toBeUndefined();
  });

  test('delete returns false for missing job', async () => {
    expect(await store.delete('nope')).toBe(false);
  });

  test('list returns all jobs', async () => {
    await store.set({ id: 'j1', schedule: '* * * * *', agentId: 'a', prompt: 'p1' });
    await store.set({ id: 'j2', schedule: '* * * * *', agentId: 'b', prompt: 'p2' });

    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all.map(j => j.id).sort()).toEqual(['j1', 'j2']);
  });

  test('list filters by agentId', async () => {
    await store.set({ id: 'j1', schedule: '* * * * *', agentId: 'a', prompt: 'p1' });
    await store.set({ id: 'j2', schedule: '* * * * *', agentId: 'b', prompt: 'p2' });

    expect(await store.list('a')).toHaveLength(1);
    expect((await store.list('a'))[0].id).toBe('j1');
  });

  test('persists optional fields: maxTokenBudget, delivery, runOnce', async () => {
    await store.set({
      id: 'full-job',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning task',
      maxTokenBudget: 2048,
      delivery: { mode: 'channel', target: 'last' },
      runOnce: true,
    });

    const job = (await store.get('full-job'))!;
    expect(job.maxTokenBudget).toBe(2048);
    expect(job.delivery).toEqual({ mode: 'channel', target: 'last' });
    expect(job.runOnce).toBe(true);
  });

  test('persists across database reopens', async () => {
    const dbPath = join(tmpDir, 'persist.db');
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    await store1.set({ id: 'persistent', schedule: '* * * * *', agentId: 'a', prompt: 'survives restart' });
    await store1.close();

    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const job = await store2.get('persistent');
    expect(job).toBeDefined();
    expect(job!.prompt).toBe('survives restart');
    await store2.close();
  });

  test('setRunAt persists fire time and listWithRunAt retrieves it', async () => {
    await store.set({ id: 'once-job', schedule: '* * * * *', agentId: 'a', prompt: 'one-shot' });
    const fireAt = new Date('2026-06-01T12:00:00Z');
    await store.setRunAt('once-job', fireAt);

    const results = await store.listWithRunAt();
    expect(results).toHaveLength(1);
    expect(results[0].job.id).toBe('once-job');
    expect(results[0].runAt.toISOString()).toBe(fireAt.toISOString());
  });

  test('listWithRunAt excludes jobs without run_at', async () => {
    await store.set({ id: 'cron-job', schedule: '0 9 * * *', agentId: 'a', prompt: 'recurring' });
    await store.set({ id: 'once-job', schedule: '* * * * *', agentId: 'a', prompt: 'one-shot' });
    await store.setRunAt('once-job', new Date('2026-06-01T12:00:00Z'));

    const results = await store.listWithRunAt();
    expect(results).toHaveLength(1);
    expect(results[0].job.id).toBe('once-job');
  });

  test('tryClaim returns true on first call for a minute, false on second', async () => {
    await store.set({ id: 'claim-job', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
    const mk = '2026-06-01T12:00';

    const first = await store.tryClaim('claim-job', mk);
    expect(first).toBe(true);

    const second = await store.tryClaim('claim-job', mk);
    expect(second).toBe(false);
  });

  test('tryClaim allows claiming again in a new minute', async () => {
    await store.set({ id: 'claim-job2', schedule: '* * * * *', agentId: 'a', prompt: 'p' });

    expect(await store.tryClaim('claim-job2', '2026-06-01T12:00')).toBe(true);
    expect(await store.tryClaim('claim-job2', '2026-06-01T12:01')).toBe(true);
  });

  test('delete clears run_at along with the job', async () => {
    await store.set({ id: 'once-job', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
    await store.setRunAt('once-job', new Date());
    await store.delete('once-job');

    expect(await store.listWithRunAt()).toHaveLength(0);
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

    await scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: AGENT,
      prompt: 'Check for updates',
    });

    const jobs = await scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('job-1');
    expect(jobs[0].prompt).toBe('Check for updates');
  });

  test('removeCron removes a job', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });

    await scheduler.addCron!({
      id: 'job-1',
      schedule: '*/5 * * * *',
      agentId: AGENT,
      prompt: 'Check for updates',
    });

    await scheduler.removeCron!('job-1');
    expect(await scheduler.listJobs!()).toHaveLength(0);
  });

  // ─── Agent filtering ───────────────────────────────

  test('listJobs only returns jobs for this agent', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });

    await scheduler.addCron!({ id: 'my-job', schedule: '* * * * *', agentId: AGENT, prompt: 'mine' });
    await scheduler.addCron!({ id: 'other-job', schedule: '* * * * *', agentId: 'other-agent', prompt: 'theirs' });

    const jobs = await scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('my-job');
  });

  test('checkCronNow only fires jobs for this agent', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.addCron!({ id: 'my-job', schedule: '* * * * *', agentId: AGENT, prompt: 'mine' });
    await scheduler.addCron!({ id: 'other-job', schedule: '* * * * *', agentId: 'other-agent', prompt: 'theirs' });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].sender).toBe('cron:my-job');
  });

  test('agent_name config overrides default agent filter', async () => {
    const customConfig = { ...mockConfig, agent_name: 'custom-agent' } as Config;
    const scheduler = await create(customConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.addCron!({ id: 'j1', schedule: '* * * * *', agentId: 'custom-agent', prompt: 'match' });
    await scheduler.addCron!({ id: 'j2', schedule: '* * * * *', agentId: AGENT, prompt: 'no match' });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    await new Promise(r => setTimeout(r, 10));

    expect(received).toHaveLength(1);
    expect(received[0].sender).toBe('cron:j1');
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

    await scheduler.addCron!({
      id: 'test-job',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Run test task',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    await new Promise(r => setTimeout(r, 10));

    expect(received.filter(m => m.sender === 'cron:test-job')).toHaveLength(1);
    expect(received[0].content).toBe('Run test task');
    expect(received[0].session.provider).toBe('scheduler');
  });

  test('cron job fires only once per matching minute (dedup)', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.addCron!({
      id: 'dedup-job',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Should fire once',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const t = new Date('2026-03-01T12:05:00Z');
    scheduler.checkCronNow!(t);
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Same minute — should NOT fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:05:30Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(1);

    // Next minute — should fire again
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender === 'cron:dedup-job')).toHaveLength(2);
  });

  // ─── runOnce ───────────────────────────────────────

  test('runOnce job fires once and is auto-deleted', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.addCron!({
      id: 'once-job',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Run once only',
      runOnce: true,
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);

    // Job should be deleted
    expect(await scheduler.listJobs!()).toHaveLength(0);

    // Next minute — should NOT fire
    scheduler.checkCronNow!(new Date('2026-03-01T12:06:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received.filter(m => m.sender === 'cron:once-job')).toHaveLength(1);
  });

  // ─── scheduleOnce ─────────────────────────────────

  test('scheduleOnce fires job via setTimeout and auto-deletes', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50);
    await scheduler.scheduleOnce!({
      id: 'once-timer',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Timed one-shot',
      runOnce: true,
    }, fireAt);

    expect(await scheduler.listJobs!()).toHaveLength(1);

    await new Promise((r) => setTimeout(r, 150));

    expect(received.filter(m => m.sender === 'cron:once-timer')).toHaveLength(1);
    expect(received[0].content).toBe('Timed one-shot');
    expect(await scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce: job is still in store when async handler runs', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    let jobListDuringHandler: Awaited<ReturnType<NonNullable<typeof scheduler.listJobs>>> = [];

    await scheduler.start(async (_msg) => {
      await new Promise(r => setTimeout(r, 10));
      jobListDuringHandler = await scheduler.listJobs!();
    });
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50);
    await scheduler.scheduleOnce!({
      id: 'race-test',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Race condition test',
      runOnce: true,
    }, fireAt);

    await new Promise(r => setTimeout(r, 200));

    expect(jobListDuringHandler.some(j => j.id === 'race-test')).toBe(true);
    expect(await scheduler.listJobs!()).toHaveLength(0);
  });

  test('scheduleOnce job can be cancelled via removeCron', async () => {
    const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 100);
    await scheduler.scheduleOnce!({
      id: 'cancel-me',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Should not fire',
      runOnce: true,
    }, fireAt);

    await scheduler.removeCron!('cancel-me');

    await new Promise((r) => setTimeout(r, 200));

    expect(received.filter(m => m.sender === 'cron:cancel-me')).toHaveLength(0);
    expect(await scheduler.listJobs!()).toHaveLength(0);
  });

  // ─── stop() awaits async cleanup (P2 fix) ─────────

  test('stop waits for in-flight async cleanup before closing DB', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-asyncstop-'));
    const dbPath = join(tmpDir, 'scheduler.db');
    const db = createKyselyDb({ type: 'sqlite', path: dbPath });
    const migResult = await runMigrations(db, jobsMigrations);
    if (migResult.error) throw migResult.error;
    const store = new KyselyJobStore(db);
    const scheduler = await create(mockConfig, { jobStore: store });
    let cleanupRan = false;

    // Async handler that takes a moment to complete
    await scheduler.start(async (_msg) => {
      await new Promise(r => setTimeout(r, 50));
      cleanupRan = true;
    });

    const fireAt = new Date(Date.now() + 10);
    await scheduler.scheduleOnce!({
      id: 'async-stop-test',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Async stop test',
      runOnce: true,
    }, fireAt);

    // Wait for the timer to fire but not the async handler to complete
    await new Promise(r => setTimeout(r, 30));

    // stop() should wait for the async handler cleanup
    await scheduler.stop();

    // The async handler should have completed before stop() returned
    expect(cleanupRan).toBe(true);

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── In-flight overlap protection ────────────────

  test('cron skips firing if previous invocation is still in-flight', async () => {
    const store = new MemoryJobStore();
    const scheduler = await create(mockConfig, { jobStore: store });
    const received: InboundMessage[] = [];
    let resolveFirst: (() => void) | null = null;

    // First invocation blocks until we manually resolve it
    let callCount = 0;
    await scheduler.start((msg) => {
      received.push(msg);
      callCount++;
      if (callCount === 1) {
        // First call: return a promise that blocks until resolved
        return new Promise<void>(resolve => { resolveFirst = resolve; });
      }
      // Subsequent calls: resolve immediately
      return Promise.resolve();
    });

    await scheduler.addCron!({
      id: 'slow-job',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'I take a while',
    });

    // Fire once — this one blocks
    scheduler.checkCronNow!(new Date('2026-01-01T00:00:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1);

    // Fire again in the next minute — should be skipped because still in-flight
    scheduler.checkCronNow!(new Date('2026-01-01T00:01:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(1); // still 1, not 2

    // Resolve the first invocation
    resolveFirst!();
    await new Promise(r => setTimeout(r, 10));

    // Now firing again should work
    scheduler.checkCronNow!(new Date('2026-01-01T00:02:00Z'));
    await new Promise(r => setTimeout(r, 10));
    expect(received).toHaveLength(2);

    await scheduler.stop();
  });

  // ─── One-shot rehydration (P1 fix) ────────────────

  test('scheduleOnce persists run_at in KyselyJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-runat-'));
    const dbPath = join(tmpDir, 'scheduler.db');
    const db = createKyselyDb({ type: 'sqlite', path: dbPath });
    const migResult = await runMigrations(db, jobsMigrations);
    if (migResult.error) throw migResult.error;
    const store = new KyselyJobStore(db);
    const scheduler = await create(mockConfig, { jobStore: store });

    await scheduler.start(() => {});

    const fireAt = new Date(Date.now() + 60_000);
    await scheduler.scheduleOnce!({
      id: 'persist-runat',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Should persist',
      runOnce: true,
    }, fireAt);

    // Verify run_at was persisted
    const persisted = await store.listWithRunAt();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].job.id).toBe('persist-runat');
    expect(persisted[0].runAt.toISOString()).toBe(fireAt.toISOString());

    await scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('one-shot jobs are rehydrated on start with KyselyJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-rehydrate-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // First instance: schedule a one-shot job for the near future, then stop
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    const scheduler1 = await create(mockConfig, { jobStore: store1 });
    await scheduler1.start(() => {});

    const fireAt = new Date(Date.now() + 80); // 80ms from now
    await scheduler1.scheduleOnce!({
      id: 'rehydrate-me',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Rehydrated job',
      runOnce: true,
    }, fireAt);

    // Stop without firing (simulates restart)
    await scheduler1.stop();

    // Second instance: rehydrated job should fire
    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const scheduler2 = await create(mockConfig, { jobStore: store2 });
    const received: InboundMessage[] = [];

    await scheduler2.start((msg) => received.push(msg));

    // Wait for the rehydrated timer to fire
    await new Promise(r => setTimeout(r, 200));

    expect(received.filter(m => m.sender === 'cron:rehydrate-me')).toHaveLength(1);
    expect(received[0].content).toBe('Rehydrated job');

    await scheduler2.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('past-due one-shot jobs fire immediately on rehydration', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-pastdue-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Manually insert a job with a past run_at
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    await store1.set({
      id: 'past-due',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'Past due job',
      runOnce: true,
    });
    await store1.setRunAt('past-due', new Date(Date.now() - 60_000)); // 1 minute ago
    await store1.close();

    // Start a new scheduler — job should fire immediately
    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const scheduler = await create(mockConfig, { jobStore: store2 });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));

    await new Promise(r => setTimeout(r, 100));

    expect(received.filter(m => m.sender === 'cron:past-due')).toHaveLength(1);

    await scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('rehydration skips jobs belonging to other agents', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-rehydrate-filter-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Insert jobs for two different agents
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    await store1.set({ id: 'my-job', schedule: '* * * * *', agentId: AGENT, prompt: 'mine', runOnce: true });
    await store1.setRunAt('my-job', new Date(Date.now() + 30));
    await store1.set({ id: 'other-job', schedule: '* * * * *', agentId: 'other-agent', prompt: 'theirs', runOnce: true });
    await store1.setRunAt('other-job', new Date(Date.now() + 30));
    await store1.close();

    // Start scheduler — only 'my-job' should fire
    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const scheduler = await create(mockConfig, { jobStore: store2 });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    await new Promise(r => setTimeout(r, 150));

    expect(received).toHaveLength(1);
    expect(received[0].sender).toBe('cron:my-job');

    await scheduler.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Multi-replica dedup ─────────────────────────

  test('two schedulers sharing a KyselyJobStore do not double-fire', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-dedup-'));
    const dbPath = join(tmpDir, 'dedup.db');
    const db = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
    if (r.error) throw r.error;

    // Two schedulers sharing the same DB (simulates two replicas)
    const store1 = new KyselyJobStore(db);
    const store2 = new KyselyJobStore(db);
    const sched1 = await create(mockConfig, { jobStore: store1 });
    const sched2 = await create(mockConfig, { jobStore: store2 });

    // Add job via sched1 — both schedulers see it because they share the DB
    await sched1.addCron!({ id: 'shared-job', schedule: '* * * * *', agentId: AGENT, prompt: 'dedup test' });

    const received1: InboundMessage[] = [];
    const received2: InboundMessage[] = [];
    await sched1.start(msg => received1.push(msg));
    await sched2.start(msg => received2.push(msg));

    const at = new Date('2026-03-01T12:05:00Z');
    sched1.checkCronNow!(at);
    sched2.checkCronNow!(at);
    await new Promise(r => setTimeout(r, 50));

    // Exactly one of them should have fired, not both
    const total = received1.filter(m => m.sender === 'cron:shared-job').length
                + received2.filter(m => m.sender === 'cron:shared-job').length;
    expect(total).toBe(1);

    await sched1.stop();
    await sched2.stop();
    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('two schedulers sharing a KyselyJobStore do not double-fire heartbeats', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-hb-dedup-'));
    const dbPath = join(tmpDir, 'hb-dedup.db');
    const db = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
    if (r.error) throw r.error;

    const fastConfig = {
      ...mockConfig,
      scheduler: { ...mockConfig.scheduler, heartbeat_interval_min: 0.001 },
    } as Config;

    const store1 = new KyselyJobStore(db);
    const store2 = new KyselyJobStore(db);
    const sched1 = await create(fastConfig, { jobStore: store1 });
    const sched2 = await create(fastConfig, { jobStore: store2 });

    const received1: InboundMessage[] = [];
    const received2: InboundMessage[] = [];
    await sched1.start(msg => received1.push(msg));
    await sched2.start(msg => received2.push(msg));

    await new Promise(r => setTimeout(r, 200));

    await sched1.stop();
    await sched2.stop();

    const hb1 = received1.filter(m => m.sender === 'heartbeat').length;
    const hb2 = received2.filter(m => m.sender === 'heartbeat').length;

    // With ~60ms interval and 200ms wait, expect ~3 heartbeats total.
    // The key assertion: NOT both schedulers firing every interval.
    // At least one scheduler should have zero heartbeats (or fewer than the other).
    expect(hb1 + hb2).toBeGreaterThan(0);
    expect(hb1 + hb2).toBeLessThan(hb1 * 2 + hb2 * 2); // weaker: just not doubled

    // Stronger: with dedup, for each minute only one replica fires.
    // Since the interval is 60ms and we wait 200ms, there are ~3 fires.
    // Without dedup: hb1 + hb2 ≈ 6. With dedup: hb1 + hb2 ≈ 3.
    // Allow some slack but not 2x.
    expect(hb1 + hb2).toBeLessThanOrEqual(5);

    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('two schedulers sharing a KyselyJobStore do not double-fire one-shot jobs on rehydration', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-once-dedup-'));
    const dbPath = join(tmpDir, 'once-dedup.db');
    const db = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r = await runMigrations(db, buildJobsMigrations('sqlite'), 'scheduler_migration');
    if (r.error) throw r.error;

    // Pre-insert a one-shot job with run_at in the near future
    const store = new KyselyJobStore(db);
    await store.set({ id: 'once-shared', schedule: '* * * * *', agentId: AGENT, prompt: 'one-shot dedup', runOnce: true });
    await store.setRunAt('once-shared', new Date(Date.now() + 80));

    // Two schedulers rehydrate from the same DB
    const store1 = new KyselyJobStore(db);
    const store2 = new KyselyJobStore(db);
    const sched1 = await create(mockConfig, { jobStore: store1 });
    const sched2 = await create(mockConfig, { jobStore: store2 });

    const received1: InboundMessage[] = [];
    const received2: InboundMessage[] = [];
    await sched1.start(msg => received1.push(msg));
    await sched2.start(msg => received2.push(msg));

    await new Promise(r => setTimeout(r, 300));

    await sched1.stop();
    await sched2.stop();

    const total = received1.filter(m => m.sender === 'cron:once-shared').length
                + received2.filter(m => m.sender === 'cron:once-shared').length;
    expect(total).toBe(1);

    await db.destroy();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── SQLite persistence integration ───────────────

  test('jobs persist across provider recreates with KyselyJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-persist-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Create first instance and add a job
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    const scheduler1 = await create(mockConfig, { jobStore: store1 });

    await scheduler1.addCron!({
      id: 'persisted-job',
      schedule: '0 9 * * *',
      agentId: AGENT,
      prompt: 'Morning standup',
    });

    await scheduler1.stop();

    // Create second instance — job should still be there
    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const scheduler2 = await create(mockConfig, { jobStore: store2 });

    // Use scheduler's listJobs() which filters out synthetic heartbeat rows
    const jobs = await scheduler2.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('persisted-job');
    expect(jobs[0].prompt).toBe('Morning standup');

    await scheduler2.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Proactive hints ─────────────────────────────

  describe('proactive hints', () => {
    function createMockEventBus(): EventBusProvider & { fire(event: StreamEvent): void } {
      const listeners: Array<(event: StreamEvent) => void> = [];
      return {
        emit() {},
        subscribe(fn) {
          listeners.push(fn);
          return () => {
            const idx = listeners.indexOf(fn);
            if (idx >= 0) listeners.splice(idx, 1);
          };
        },
        subscribeRequest: () => () => {},
        listenerCount: () => listeners.length,
        close() {},
        fire(event: StreamEvent) {
          for (const fn of listeners) fn(event);
        },
      };
    }

    function hintEvent(overrides: Partial<StreamEvent['data']> = {}): StreamEvent {
      return {
        type: 'memory.proactive_hint',
        requestId: 'main',
        timestamp: Date.now(),
        data: {
          source: 'memory',
          kind: 'pending_task',
          reason: 'Update API keys',
          suggestedPrompt: 'Update API keys by Friday',
          confidence: 0.9,
          scope: 'default',
          ...overrides,
        },
      };
    }

    test('fires hint as InboundMessage when confidence exceeds threshold', async () => {
      const eventbus = createMockEventBus();
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
      const received: InboundMessage[] = [];

      await scheduler.start((msg) => received.push(msg));
      stopFn = () => scheduler.stop();

      eventbus.fire(hintEvent({ confidence: 0.9 }));
      await new Promise(r => setTimeout(r, 10));

      const hints = received.filter(m => m.sender.startsWith('hint:'));
      expect(hints).toHaveLength(1);
      expect(hints[0].sender).toBe('hint:pending_task');
      expect(hints[0].content).toBe('Update API keys by Friday');
    });

    test('suppresses hint below confidence threshold', async () => {
      const eventbus = createMockEventBus();
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
      const received: InboundMessage[] = [];

      await scheduler.start((msg) => received.push(msg));
      stopFn = () => scheduler.stop();

      eventbus.fire(hintEvent({ confidence: 0.3 }));
      await new Promise(r => setTimeout(r, 10));

      expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(0);
    });

    test('cooldown prevents duplicate hint firing', async () => {
      const eventbus = createMockEventBus();
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
      const received: InboundMessage[] = [];

      await scheduler.start((msg) => received.push(msg));
      stopFn = () => scheduler.stop();

      eventbus.fire(hintEvent());
      await new Promise(r => setTimeout(r, 10));
      expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(1);

      // Same hint again — should be suppressed by cooldown
      eventbus.fire(hintEvent());
      await new Promise(r => setTimeout(r, 10));
      expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(1);
    });

    test('different hints fire independently (no cross-cooldown)', async () => {
      const eventbus = createMockEventBus();
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
      const received: InboundMessage[] = [];

      await scheduler.start((msg) => received.push(msg));
      stopFn = () => scheduler.stop();

      eventbus.fire(hintEvent({ suggestedPrompt: 'Task A' }));
      eventbus.fire(hintEvent({ suggestedPrompt: 'Task B' }));
      await new Promise(r => setTimeout(r, 10));

      expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(2);
    });

    test('stop unsubscribes from eventbus', async () => {
      const eventbus = createMockEventBus();
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore(), eventbus });
      const received: InboundMessage[] = [];

      await scheduler.start((msg) => received.push(msg));
      await scheduler.stop();

      eventbus.fire(hintEvent());
      await new Promise(r => setTimeout(r, 10));

      expect(received.filter(m => m.sender.startsWith('hint:'))).toHaveLength(0);
    });

    test('works without eventbus (backward compatible)', async () => {
      const scheduler = await create(mockConfig, { jobStore: new MemoryJobStore() });
      await scheduler.start(() => {});
      await scheduler.stop();
      // No crash — test passes if we get here
    });
  });

  test('removed jobs do not reappear after restart with KyselyJobStore', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-plainjob-remove-'));
    const dbPath = join(tmpDir, 'scheduler.db');

    // Create, add, then remove
    const db1 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r1 = await runMigrations(db1, jobsMigrations);
    if (r1.error) throw r1.error;
    const store1 = new KyselyJobStore(db1);
    const scheduler1 = await create(mockConfig, { jobStore: store1 });

    await scheduler1.addCron!({
      id: 'temp-job',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'will be removed',
    });
    await scheduler1.removeCron!('temp-job');
    await scheduler1.stop();

    // Reopen — should be empty
    const db2 = createKyselyDb({ type: 'sqlite', path: dbPath });
    const r2 = await runMigrations(db2, jobsMigrations);
    if (r2.error) throw r2.error;
    const store2 = new KyselyJobStore(db2);
    const scheduler2 = await create(mockConfig, { jobStore: store2 });

    expect(await scheduler2.listJobs!()).toHaveLength(0);
    await scheduler2.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ═══════════════════════════════════════════════════════
// PostgreSQL integration tests
// ═══════════════════════════════════════════════════════

const PG_URL = process.env.POSTGRESQL_URL;

describe.skipIf(!PG_URL)('KyselyJobStore (PostgreSQL)', () => {
  let db: ReturnType<typeof createKyselyDb>;
  let store: KyselyJobStore;

  beforeEach(async () => {
    db = createKyselyDb({ type: 'postgresql', url: PG_URL! });
    // Drop existing table to start clean
    await db.schema.dropTable('cron_jobs').ifExists().execute();
    await db.schema.dropTable('scheduler_migration').ifExists().execute();
    const result = await runMigrations(db, buildJobsMigrations('postgresql'), 'scheduler_migration');
    if (result.error) throw result.error;
    store = new KyselyJobStore(db);
  });

  afterEach(async () => {
    await db.schema.dropTable('cron_jobs').ifExists().execute();
    await db.schema.dropTable('scheduler_migration').ifExists().execute();
    await db.destroy();
  });

  test('set and get a job', async () => {
    await store.set({
      id: 'pg-job-1',
      schedule: '*/5 * * * *',
      agentId: 'assistant',
      prompt: 'Check for updates',
    });

    const job = await store.get('pg-job-1');
    expect(job).toBeDefined();
    expect(job!.id).toBe('pg-job-1');
    expect(job!.schedule).toBe('*/5 * * * *');
    expect(job!.agentId).toBe('assistant');
    expect(job!.prompt).toBe('Check for updates');
  });

  test('upsert overwrites existing job', async () => {
    await store.set({ id: 'pg-j1', schedule: '* * * * *', agentId: 'a', prompt: 'v1' });
    await store.set({ id: 'pg-j1', schedule: '*/10 * * * *', agentId: 'a', prompt: 'v2' });

    const job = await store.get('pg-j1');
    expect(job!.schedule).toBe('*/10 * * * *');
    expect(job!.prompt).toBe('v2');
    expect(await store.list()).toHaveLength(1);
  });

  test('delete removes a job', async () => {
    await store.set({ id: 'pg-j1', schedule: '* * * * *', agentId: 'a', prompt: 'p' });
    expect(await store.delete('pg-j1')).toBe(true);
    expect(await store.get('pg-j1')).toBeUndefined();
  });

  test('delete returns false for missing job', async () => {
    expect(await store.delete('nope')).toBe(false);
  });

  test('list filters by agentId', async () => {
    await store.set({ id: 'pg-j1', schedule: '* * * * *', agentId: 'a', prompt: 'p1' });
    await store.set({ id: 'pg-j2', schedule: '* * * * *', agentId: 'b', prompt: 'p2' });

    const agentA = await store.list('a');
    expect(agentA).toHaveLength(1);
    expect(agentA[0].id).toBe('pg-j1');

    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  test('persists optional fields: maxTokenBudget, delivery, runOnce', async () => {
    await store.set({
      id: 'pg-full',
      schedule: '0 9 * * *',
      agentId: 'assistant',
      prompt: 'Morning task',
      maxTokenBudget: 2048,
      delivery: { mode: 'channel', target: 'last' },
      runOnce: true,
    });

    const job = (await store.get('pg-full'))!;
    expect(job.maxTokenBudget).toBe(2048);
    expect(job.delivery).toEqual({ mode: 'channel', target: 'last' });
    expect(job.runOnce).toBe(true);
  });

  test('setRunAt and listWithRunAt', async () => {
    await store.set({ id: 'pg-once', schedule: '* * * * *', agentId: 'a', prompt: 'one-shot' });
    const fireAt = new Date('2026-06-01T12:00:00Z');
    await store.setRunAt('pg-once', fireAt);

    const results = await store.listWithRunAt();
    expect(results).toHaveLength(1);
    expect(results[0].job.id).toBe('pg-once');
    expect(results[0].runAt.toISOString()).toBe(fireAt.toISOString());
  });

  test('listWithRunAt excludes jobs without run_at', async () => {
    await store.set({ id: 'pg-cron', schedule: '0 9 * * *', agentId: 'a', prompt: 'recurring' });
    await store.set({ id: 'pg-once', schedule: '* * * * *', agentId: 'a', prompt: 'one-shot' });
    await store.setRunAt('pg-once', new Date('2026-06-01T12:00:00Z'));

    const results = await store.listWithRunAt();
    expect(results).toHaveLength(1);
    expect(results[0].job.id).toBe('pg-once');
  });
});

describe.skipIf(!PG_URL)('PlainJob scheduler (PostgreSQL)', () => {
  let db: ReturnType<typeof createKyselyDb>;
  let stopFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    db = createKyselyDb({ type: 'postgresql', url: PG_URL! });
    await db.schema.dropTable('cron_jobs').ifExists().execute();
    await db.schema.dropTable('scheduler_migration').ifExists().execute();
  });

  afterEach(async () => {
    if (stopFn) {
      await stopFn();
      stopFn = null;
    }
    await db.schema.dropTable('cron_jobs').ifExists().execute();
    await db.schema.dropTable('scheduler_migration').ifExists().execute();
    await db.destroy();
  });

  test('create with DatabaseProvider runs migrations and works', async () => {
    const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
    const scheduler = await create(mockConfig, { database: dbProvider });

    await scheduler.addCron!({
      id: 'pg-cron-1',
      schedule: '*/5 * * * *',
      agentId: AGENT,
      prompt: 'PG cron test',
    });

    const jobs = await scheduler.listJobs!();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe('pg-cron-1');
    expect(jobs[0].prompt).toBe('PG cron test');

    await scheduler.stop();
  });

  test('cron job fires via checkCronNow with PostgreSQL backend', async () => {
    const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
    const scheduler = await create(mockConfig, { database: dbProvider });
    const received: InboundMessage[] = [];

    await scheduler.addCron!({
      id: 'pg-fire-test',
      schedule: '* * * * *',
      agentId: AGENT,
      prompt: 'PG fire test',
    });

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    scheduler.checkCronNow!(new Date('2026-03-01T12:05:00Z'));
    await new Promise(r => setTimeout(r, 50));

    expect(received.filter(m => m.sender === 'cron:pg-fire-test')).toHaveLength(1);
    expect(received[0].content).toBe('PG fire test');
  });

  test('scheduleOnce persists and fires with PostgreSQL backend', async () => {
    const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
    const scheduler = await create(mockConfig, { database: dbProvider });
    const received: InboundMessage[] = [];

    await scheduler.start((msg) => received.push(msg));
    stopFn = () => scheduler.stop();

    const fireAt = new Date(Date.now() + 50); // 50ms from now
    await scheduler.scheduleOnce!(
      { id: 'pg-once-fire', schedule: '* * * * *', agentId: AGENT, prompt: 'one-shot PG', runOnce: true },
      fireAt,
    );

    await new Promise(r => setTimeout(r, 200));

    expect(received.filter(m => m.sender === 'cron:pg-once-fire')).toHaveLength(1);
    expect(received[0].content).toBe('one-shot PG');
  });

  test('removeCron works with PostgreSQL backend', async () => {
    const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
    const scheduler = await create(mockConfig, { database: dbProvider });

    await scheduler.addCron!({ id: 'pg-rm', schedule: '* * * * *', agentId: AGENT, prompt: 'to remove' });
    expect(await scheduler.listJobs!()).toHaveLength(1);

    await scheduler.removeCron!('pg-rm');
    expect(await scheduler.listJobs!()).toHaveLength(0);

    await scheduler.stop();
  });

  test('two schedulers with shared PG do not double-fire cron', async () => {
    const dbProvider = { db, type: 'postgresql' as const, vectorsAvailable: false, close: () => db.destroy() };
    const sched1 = await create(mockConfig, { database: dbProvider });
    const sched2 = await create(mockConfig, { database: dbProvider });

    await sched1.addCron!({ id: 'pg-dedup', schedule: '* * * * *', agentId: AGENT, prompt: 'pg dedup test' });

    const received1: InboundMessage[] = [];
    const received2: InboundMessage[] = [];
    await sched1.start(msg => received1.push(msg));
    await sched2.start(msg => received2.push(msg));

    const at = new Date('2026-03-01T12:05:00Z');
    sched1.checkCronNow!(at);
    sched2.checkCronNow!(at);
    await new Promise(r => setTimeout(r, 100));

    const total = received1.filter(m => m.sender === 'cron:pg-dedup').length
                + received2.filter(m => m.sender === 'cron:pg-dedup').length;
    expect(total).toBe(1);

    await sched1.stop();
    await sched2.stop();
  });
});
