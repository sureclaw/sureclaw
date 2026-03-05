import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { create } from '../../../src/providers/audit/database.js';
import { create as createSqliteDb } from '../../../src/providers/database/sqlite.js';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AuditProvider } from '../../../src/providers/audit/types.js';
import type { DatabaseProvider } from '../../../src/providers/database/types.js';
import type { Config } from '../../../src/types.js';

const config = {} as Config;

describe('audit/database', () => {
  let audit: AuditProvider;
  let database: DatabaseProvider;
  let testHome: string;

  beforeEach(async () => {
    testHome = join(tmpdir(), `ax-audit-db-test-${randomUUID()}`);
    mkdirSync(testHome, { recursive: true });
    process.env.AX_HOME = testHome;
    database = await createSqliteDb(config);
    audit = await create(config, 'database', { database });
  });

  afterEach(async () => {
    try { await database.close(); } catch {}
    try { rmSync(testHome, { recursive: true, force: true }); } catch {}
    delete process.env.AX_HOME;
  });

  test('log and query entries', async () => {
    await audit.log({
      sessionId: 's1',
      action: 'tool_call',
      args: { tool: 'bash' },
      result: 'success',
      durationMs: 42,
    });

    const entries = await audit.query({});
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('tool_call');
    expect(entries[0].durationMs).toBe(42);
  });

  test('query filters by action', async () => {
    await audit.log({ action: 'tool_call', result: 'success' });
    await audit.log({ action: 'ipc_request', result: 'success' });

    const entries = await audit.query({ action: 'tool_call' });
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('tool_call');
  });

  test('query filters by sessionId', async () => {
    await audit.log({ sessionId: 's1', action: 'a', result: 'success' });
    await audit.log({ sessionId: 's2', action: 'b', result: 'success' });

    const entries = await audit.query({ sessionId: 's1' });
    expect(entries.length).toBe(1);
    expect(entries[0].action).toBe('a');
  });

  test('query respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.log({ action: `a${i}`, result: 'success' });
    }

    const entries = await audit.query({ limit: 2 });
    expect(entries.length).toBe(2);
    // Should return the LAST 2 entries
    expect(entries[0].action).toBe('a3');
    expect(entries[1].action).toBe('a4');
  });

  test('log includes token usage', async () => {
    await audit.log({
      action: 'llm_call',
      result: 'success',
      tokenUsage: { input: 100, output: 50 },
    });

    const entries = await audit.query({});
    expect(entries[0].tokenUsage).toEqual({ input: 100, output: 50 });
  });

  test('throws when no database provider given', async () => {
    await expect(create(config, 'database'))
      .rejects.toThrow('audit/database requires a database provider');
  });
});
