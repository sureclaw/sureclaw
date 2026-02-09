import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../src/providers/audit/file.js';
import { unlinkSync, existsSync } from 'node:fs';
import type { Config } from '../../src/providers/types.js';

const config = {} as Config;
const AUDIT_PATH = 'data/audit/audit.jsonl';

describe('audit-file provider', () => {
  let provider: Awaited<ReturnType<typeof create>>;

  beforeEach(async () => {
    // Clean up before each test
    try { unlinkSync(AUDIT_PATH); } catch {}
    provider = await create(config);
  });

  afterEach(() => {
    try { unlinkSync(AUDIT_PATH); } catch {}
  });

  test('logs entries to JSONL file', async () => {
    await provider.log({ action: 'test_action', sessionId: 's1', result: 'success', durationMs: 10 });
    expect(existsSync(AUDIT_PATH)).toBe(true);
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
    try { unlinkSync(AUDIT_PATH); } catch {}
    const freshProvider = await create(config);
    const entries = await freshProvider.query({});
    expect(entries).toEqual([]);
  });

  test('respects limit filter', async () => {
    for (let i = 0; i < 5; i++) {
      await provider.log({ action: `action_${i}`, sessionId: 's1', result: 'success', durationMs: i });
    }
    const limited = await provider.query({ limit: 2 });
    expect(limited).toHaveLength(2);
  });
});
