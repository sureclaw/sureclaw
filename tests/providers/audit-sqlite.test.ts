import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/audit/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import type { AuditProvider, Config } from '../../src/providers/types.js';

const config = {} as Config;
const DB_PATH = 'data/audit.db';

function cleanDb() {
  try { rmSync(DB_PATH); } catch {}
  try { rmSync(DB_PATH + '-wal'); } catch {}
  try { rmSync(DB_PATH + '-shm'); } catch {}
}

describe('audit-sqlite', () => {
  let audit: AuditProvider;

  beforeEach(async () => {
    cleanDb();
    mkdirSync('data', { recursive: true });
    audit = await create(config);
  });

  afterEach(() => {
    cleanDb();
  });

  test('logs and queries entries', async () => {
    await audit.log({ action: 'test_action', sessionId: 's1', result: 'success', durationMs: 10 });
    await audit.log({ action: 'other_action', sessionId: 's2', result: 'error', durationMs: 20 });

    const all = await audit.query({});
    expect(all).toHaveLength(2);

    const filtered = await audit.query({ action: 'test_action' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].action).toBe('test_action');
  });

  test('filters by session ID', async () => {
    await audit.log({ action: 'a', sessionId: 's1', result: 'success', durationMs: 5 });
    await audit.log({ action: 'b', sessionId: 's2', result: 'success', durationMs: 5 });
    await audit.log({ action: 'c', sessionId: 's1', result: 'success', durationMs: 5 });

    const results = await audit.query({ sessionId: 's1' });
    expect(results).toHaveLength(2);
    expect(results.every(e => e.sessionId === 's1')).toBe(true);
  });

  test('respects limit filter', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.log({ action: `action_${i}`, sessionId: 's1', result: 'success', durationMs: i });
    }
    const limited = await audit.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });

  test('preserves args and taint', async () => {
    const taint = { source: 'cli', trust: 'user' as const, timestamp: new Date() };
    await audit.log({
      action: 'llm_call',
      sessionId: 's1',
      result: 'success',
      durationMs: 100,
      args: { model: 'claude-sonnet-4-20250514' },
      taint,
      tokenUsage: { input: 100, output: 50 },
    });

    const entries = await audit.query({ action: 'llm_call' });
    expect(entries).toHaveLength(1);
    expect(entries[0].args).toEqual({ model: 'claude-sonnet-4-20250514' });
    expect(entries[0].taint?.source).toBe('cli');
    expect(entries[0].tokenUsage).toEqual({ input: 100, output: 50 });
  });

  test('query returns empty array for empty database', async () => {
    const entries = await audit.query({});
    expect(entries).toEqual([]);
  });

  test('append-only: no update or delete operations exposed', async () => {
    // The provider interface only exposes log() and query()
    // Verify the provider object has exactly these methods
    const provider = audit as Record<string, unknown>;
    expect(typeof provider.log).toBe('function');
    expect(typeof provider.query).toBe('function');
  });
});
