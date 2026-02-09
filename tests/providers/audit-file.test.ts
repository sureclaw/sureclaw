import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/audit/file.js';
import { unlinkSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dataFile } from '../../src/paths.js';
import type { Config } from '../../src/providers/types.js';

const config = {} as Config;

describe('audit-file provider', () => {
  let provider: Awaited<ReturnType<typeof create>>;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `sc-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    provider = await create(config);
  });

  afterEach(() => {
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  test('logs entries to JSONL file', async () => {
    await provider.log({ action: 'test_action', sessionId: 's1', result: 'success', durationMs: 10 });
    expect(existsSync(dataFile('audit', 'audit.jsonl'))).toBe(true);
  });

  test('queries logged entries', async () => {
    await provider.log({ action: 'action_a', sessionId: 's1', result: 'success', durationMs: 10 });
    await provider.log({ action: 'action_b', sessionId: 's2', result: 'error', durationMs: 20 });

    const all = await provider.query({});
    expect(all).toHaveLength(2);

    const filtered = await provider.query({ action: 'action_a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].action).toBe('action_a');
  });

  test('query returns empty array when no log file', async () => {
    try { unlinkSync(dataFile('audit', 'audit.jsonl')); } catch {}
    const freshProvider = await create(config);
    const entries = await freshProvider.query({});
    expect(entries).toEqual([]);
  });

  test('log succeeds even if data directory is removed after create', async () => {
    const auditDir = dataFile('audit');
    // Simulate directory disappearing mid-session (e.g. test cleanup, manual rm)
    rmSync(auditDir, { recursive: true, force: true });
    expect(existsSync(auditDir)).toBe(false);

    // Should NOT throw — log() must recreate the directory
    await provider.log({ action: 'after_rmdir', sessionId: 's1', result: 'success', durationMs: 1 });
    expect(existsSync(dataFile('audit', 'audit.jsonl'))).toBe(true);

    const entries = await provider.query({ action: 'after_rmdir' });
    expect(entries).toHaveLength(1);
  });

  test('respects limit filter', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.log({ action: `action_${i}`, sessionId: 's1', result: 'success', durationMs: i });
    }
    const limited = await provider.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
