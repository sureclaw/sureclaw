import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteJobStore } from '../src/job-store.js';
import { MemoryJobStore } from '../src/providers/scheduler/types.js';
import type { CronJobDef, JobStore } from '../src/providers/scheduler/types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  afterEach(() => {
    store.close();
    cleanup();
  });

  it('get returns undefined for nonexistent job', () => {
    expect(store.get('does-not-exist')).toBeUndefined();
  });

  it('set and get round-trip a basic job', () => {
    const job = basicJob();
    store.set(job);
    expect(store.get('job-1')).toEqual(job);
  });

  it('set and get round-trip a job with maxTokenBudget', () => {
    const job = basicJob({ maxTokenBudget: 8000 });
    store.set(job);
    expect(store.get('job-1')).toEqual(job);
  });

  it('set and get round-trip a job with delivery (mode: channel, target: SessionAddress)', () => {
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
    store.set(job);
    const retrieved = store.get('job-1');
    expect(retrieved).toEqual(job);
    expect(retrieved!.delivery!.mode).toBe('channel');
    expect(retrieved!.delivery!.target).toEqual({
      provider: 'slack',
      scope: 'channel',
      identifiers: { workspace: 'T111', channel: 'C222' },
    });
  });

  it('set and get round-trip a job with delivery (mode: channel, target: last)', () => {
    const job = basicJob({
      delivery: {
        mode: 'channel',
        target: 'last',
      },
    });
    store.set(job);
    const retrieved = store.get('job-1');
    expect(retrieved).toEqual(job);
    expect(retrieved!.delivery!.target).toBe('last');
  });

  it('set overwrites existing job (upsert)', () => {
    store.set(basicJob({ prompt: 'original' }));
    store.set(basicJob({ prompt: 'updated' }));
    const retrieved = store.get('job-1');
    expect(retrieved!.prompt).toBe('updated');
  });

  it('delete returns true for existing job and removes it', () => {
    store.set(basicJob());
    expect(store.delete('job-1')).toBe(true);
    expect(store.get('job-1')).toBeUndefined();
  });

  it('delete returns false for nonexistent job', () => {
    expect(store.delete('does-not-exist')).toBe(false);
  });

  it('list() returns all jobs', () => {
    store.set(basicJob({ id: 'j1', agentId: 'a1' }));
    store.set(basicJob({ id: 'j2', agentId: 'a2' }));
    store.set(basicJob({ id: 'j3', agentId: 'a1' }));
    const all = store.list();
    expect(all).toHaveLength(3);
    const ids = all.map(j => j.id).sort();
    expect(ids).toEqual(['j1', 'j2', 'j3']);
  });

  it('list(agentId) filters by agent', () => {
    store.set(basicJob({ id: 'j1', agentId: 'a1' }));
    store.set(basicJob({ id: 'j2', agentId: 'a2' }));
    store.set(basicJob({ id: 'j3', agentId: 'a1' }));
    const filtered = store.list('a1');
    expect(filtered).toHaveLength(2);
    const ids = filtered.map(j => j.id).sort();
    expect(ids).toEqual(['j1', 'j3']);
  });

  it('list() returns empty array when no jobs', () => {
    expect(store.list()).toEqual([]);
  });
}

// ─── MemoryJobStore ────────────────────────────────

describe('MemoryJobStore', () => {
  jobStoreTests(
    () => new MemoryJobStore(),
    () => { /* no filesystem cleanup needed */ },
  );
});

// ─── SqliteJobStore ────────────────────────────────

describe('SqliteJobStore', () => {
  let tmpDir: string;

  jobStoreTests(
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), 'ax-job-store-test-'));
      return SqliteJobStore.create(join(tmpDir, 'jobs.db'));
    },
    () => {
      rmSync(tmpDir, { recursive: true, force: true });
    },
  );
});
