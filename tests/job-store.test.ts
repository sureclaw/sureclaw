import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KyselyJobStore } from '../src/job-store.js';
import { MemoryJobStore } from '../src/providers/scheduler/types.js';
import type { CronJobDef, JobStore } from '../src/providers/scheduler/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKyselyDb } from '../src/utils/database.js';
import { runMigrations } from '../src/utils/migrator.js';
import { jobsMigrations } from '../src/migrations/jobs.js';
import type { Kysely } from 'kysely';

// ─── Fixtures ──────────────────────────────────────

function basicJob(overrides?: Partial<CronJobDef>): CronJobDef {
  return {
    id: 'job-1',
    schedule: '0 9 * * *',
    agentId: 'agent-a',
    prompt: 'Good morning report',
    ...overrides,
  };
}

// ─── Shared test suite ─────────────────────────────

function jobStoreTests(createStore: () => JobStore | Promise<JobStore>, cleanup: () => void) {
  let store: JobStore;

  beforeEach(async () => {
    store = await createStore();
  });

  afterEach(async () => {
    await store.close();
    cleanup();
  });

  it('get returns undefined for nonexistent job', async () => {
    expect(await store.get('does-not-exist')).toBeUndefined();
  });

  it('set and get round-trip a basic job', async () => {
    const job = basicJob();
    await store.set(job);
    expect(await store.get('job-1')).toEqual(job);
  });

  it('set and get round-trip a job with maxTokenBudget', async () => {
    const job = basicJob({ maxTokenBudget: 8000 });
    await store.set(job);
    expect(await store.get('job-1')).toEqual(job);
  });

  it('set and get round-trip a job with delivery (mode: channel, target: SessionAddress)', async () => {
    const job = basicJob({
      delivery: {
        mode: 'channel',
        target: {
          provider: 'slack',
          scope: 'channel',
          identifiers: { workspace: 'T111', channel: 'C222' },
        },
      },
    });
    await store.set(job);
    const retrieved = await store.get('job-1');
    expect(retrieved).toEqual(job);
    expect(retrieved!.delivery!.mode).toBe('channel');
    expect(retrieved!.delivery!.target).toEqual({
      provider: 'slack',
      scope: 'channel',
      identifiers: { workspace: 'T111', channel: 'C222' },
    });
  });

  it('set and get round-trip a job with delivery (mode: channel, target: last)', async () => {
    const job = basicJob({
      delivery: {
        mode: 'channel',
        target: 'last',
      },
    });
    await store.set(job);
    const retrieved = await store.get('job-1');
    expect(retrieved).toEqual(job);
    expect(retrieved!.delivery!.target).toBe('last');
  });

  it('set overwrites existing job (upsert)', async () => {
    await store.set(basicJob({ prompt: 'original' }));
    await store.set(basicJob({ prompt: 'updated' }));
    const retrieved = await store.get('job-1');
    expect(retrieved!.prompt).toBe('updated');
  });

  it('delete returns true for existing job and removes it', async () => {
    await store.set(basicJob());
    expect(await store.delete('job-1')).toBe(true);
    expect(await store.get('job-1')).toBeUndefined();
  });

  it('delete returns false for nonexistent job', async () => {
    expect(await store.delete('does-not-exist')).toBe(false);
  });

  it('list() returns all jobs', async () => {
    await store.set(basicJob({ id: 'j1', agentId: 'a1' }));
    await store.set(basicJob({ id: 'j2', agentId: 'a2' }));
    await store.set(basicJob({ id: 'j3', agentId: 'a1' }));
    const all = await store.list();
    expect(all).toHaveLength(3);
    const ids = all.map(j => j.id).sort();
    expect(ids).toEqual(['j1', 'j2', 'j3']);
  });

  it('list(agentId) filters by agent', async () => {
    await store.set(basicJob({ id: 'j1', agentId: 'a1' }));
    await store.set(basicJob({ id: 'j2', agentId: 'a2' }));
    await store.set(basicJob({ id: 'j3', agentId: 'a1' }));
    const filtered = await store.list('a1');
    expect(filtered).toHaveLength(2);
    const ids = filtered.map(j => j.id).sort();
    expect(ids).toEqual(['j1', 'j3']);
  });

  it('list() returns empty array when no jobs', async () => {
    expect(await store.list()).toEqual([]);
  });
}

// ─── MemoryJobStore ────────────────────────────────

describe('MemoryJobStore', () => {
  jobStoreTests(
    () => new MemoryJobStore(),
    () => { /* no filesystem cleanup needed */ },
  );
});

// ─── KyselyJobStore ────────────────────────────────

describe('KyselyJobStore', () => {
  let tmpDir: string;
  let db: Kysely<any>;

  jobStoreTests(
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ax-job-store-test-'));
      db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'jobs.db') });
      const result = await runMigrations(db, jobsMigrations);
      if (result.error) throw result.error;
      return new KyselyJobStore(db);
    },
    () => {
      db?.destroy();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  );

  it('setRunAt and listWithRunAt round-trip', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-job-store-test-'));
    db = createKyselyDb({ type: 'sqlite', path: join(tmpDir, 'jobs.db') });
    const result = await runMigrations(db, jobsMigrations);
    if (result.error) throw result.error;
    const store = new KyselyJobStore(db);

    const job = basicJob({ runOnce: true });
    await store.set(job);
    const fireAt = new Date('2026-03-15T10:00:00Z');
    await store.setRunAt(job.id, fireAt);

    const withRunAt = await store.listWithRunAt();
    expect(withRunAt).toHaveLength(1);
    expect(withRunAt[0].job.id).toBe('job-1');
    expect(withRunAt[0].runAt.toISOString()).toBe('2026-03-15T10:00:00.000Z');
    await store.close();
  });
});
