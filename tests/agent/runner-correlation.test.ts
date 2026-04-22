// tests/agent/runner-correlation.test.ts — agent runner reqId correlation
//
// Verifies that when the runner module loads with AX_REQUEST_ID set, every
// log line emitted from the runner's module-level logger child carries
// `reqId` (last 8 chars of AX_REQUEST_ID) bindings — so a single
// `grep <reqId>` reconstructs the chain across host + sandbox provider +
// agent runner logs.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { Writable } from 'node:stream';

/** Capture all log entries emitted by the singleton logger as parsed JSON objects. */
function captureLogs(): { entries: Record<string, unknown>[]; stream: Writable } {
  const entries: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      const text = chunk.toString();
      // pino multistream may write multiple lines in one chunk
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* ignore non-JSON */ }
      }
      cb();
    },
  });
  return { entries, stream };
}

describe('agent runner correlation', () => {
  const originalReqId = process.env.AX_REQUEST_ID;

  beforeEach(async () => {
    // Reset module cache so runner.ts re-runs its top-level logger
    // initialization against the freshly init'd singleton + current env.
    vi.resetModules();
    const { resetLogger } = await import('../../src/logger.js');
    resetLogger();
  });

  afterEach(async () => {
    if (originalReqId === undefined) delete process.env.AX_REQUEST_ID;
    else process.env.AX_REQUEST_ID = originalReqId;
    const { resetLogger } = await import('../../src/logger.js');
    resetLogger();
  });

  test('reads AX_REQUEST_ID from env and includes reqId on runner logger', async () => {
    const { entries, stream } = captureLogs();

    // Init the singleton logger BEFORE importing runner.ts so its top-level
    // `logger.child(...)` binds against this captured stream.
    const { initLogger } = await import('../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    const requestId = 'req-runner-1234567890ab';
    process.env.AX_REQUEST_ID = requestId;

    // Fresh import so the module-level logger captures AX_REQUEST_ID
    // (vi.resetModules() in beforeEach cleared the cached copy).
    const runnerModule = await import('../../src/agent/runner.js');

    // The runner doesn't export its module-level `logger`, so drive an emit
    // through the public `run()` API. An invalid agent type triggers
    // `logger.debug('dispatch')` + `logger.error('unknown_agent')` then calls
    // `process.exit` — both lines MUST carry `reqId` from AX_REQUEST_ID.
    const cfg = {
      agent: 'invalid-agent-type' as never,
      ipcSocket: '',
      workspace: '/tmp/nonexistent-ax-runner-correlation',
    };

    // run() will log 'dispatch' then 'unknown_agent' and call process.exit.
    // Stub process.exit so the test doesn't terminate.
    const origExit = process.exit;
    let exitCalled = false;
    (process as any).exit = (_code?: number) => { exitCalled = true; };
    try {
      await runnerModule.run(cfg);
    } catch { /* ignore */ }
    process.exit = origExit;
    // Give pino multistream a tick to flush.
    await new Promise(r => setTimeout(r, 20));

    expect(exitCalled).toBe(true);

    // Find runner-component entries; they MUST carry reqId from AX_REQUEST_ID.
    const runnerEntries = entries.filter(e => e.component === 'runner');
    expect(runnerEntries.length).toBeGreaterThan(0);
    for (const e of runnerEntries) {
      expect(e.reqId).toBe(requestId.slice(-8));
    }
  });

  test('hot-path runners (pi-session, claude-code) bind reqId from AX_REQUEST_ID', async () => {
    // The bulk of agent-execution chatter flows through the per-runner module
    // loggers (pi-session.ts, claude-code.ts), not the runner.ts top-level
    // logger. Drive one log emit from each runner's module-level logger and
    // assert reqId is bound — proving the env-read at import time worked.
    const { entries, stream } = captureLogs();

    const { initLogger } = await import('../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    const requestId = 'req-hotpath-abcdef0123456789';
    process.env.AX_REQUEST_ID = requestId;

    // Fresh imports — vi.resetModules() in beforeEach cleared the cached copy
    // so the module-level `logger` const re-binds against current env.
    const { runPiSession } = await import('../../src/agent/runners/pi-session.js');
    const { runClaudeCode } = await import('../../src/agent/runners/claude-code.js');

    // Trigger one emit from pi-session's module logger: empty userMessage
    // hits the `logger.debug('skip_empty')` branch and returns immediately.
    await runPiSession({
      agent: 'pi-coding-agent',
      ipcSocket: '',
      workspace: '/tmp/nonexistent-ax-pi-correlation',
      userMessage: '',
    });

    // Trigger one emit from claude-code's module logger: non-empty
    // userMessage with no proxySocket and no AX_HOST_URL hits
    // `logger.error('missing_proxy_socket')` then `process.exit(1)`.
    const origExit = process.exit;
    let exitCalled = false;
    (process as any).exit = (_code?: number) => { exitCalled = true; };
    try {
      await runClaudeCode({
        agent: 'claude-code',
        ipcSocket: '',
        workspace: '/tmp/nonexistent-ax-cc-correlation',
        userMessage: 'force log emit',
      });
    } catch { /* ignore — exit stub may break the rest of the function */ }
    process.exit = origExit;

    await new Promise(r => setTimeout(r, 20));
    expect(exitCalled).toBe(true);

    const piEntries = entries.filter(e => e.component === 'pi-session');
    const ccEntries = entries.filter(e => e.component === 'claude-code');
    expect(piEntries.length).toBeGreaterThan(0);
    expect(ccEntries.length).toBeGreaterThan(0);
    for (const e of [...piEntries, ...ccEntries]) {
      expect(e.reqId).toBe(requestId.slice(-8));
    }
  });

  test('omits reqId binding when AX_REQUEST_ID is unset', async () => {
    const { entries, stream } = captureLogs();
    const { initLogger } = await import('../../src/logger.js');
    initLogger({ level: 'debug', stream, file: false, pretty: false });

    delete process.env.AX_REQUEST_ID;

    // Fresh import without reqId in env (vi.resetModules() ran in beforeEach).
    const runnerModule = await import('../../src/agent/runner.js');

    const cfg = {
      agent: 'invalid-agent-type' as never,
      ipcSocket: '',
      workspace: '/tmp/nonexistent-ax-runner-correlation-noreq',
    };
    const origExit = process.exit;
    (process as any).exit = (_code?: number) => {};
    try {
      await runnerModule.run(cfg);
    } catch { /* ignore */ }
    process.exit = origExit;
    await new Promise(r => setTimeout(r, 20));

    const runnerEntries = entries.filter(e => e.component === 'runner');
    expect(runnerEntries.length).toBeGreaterThan(0);
    for (const e of runnerEntries) {
      expect(e.reqId).toBeUndefined();
    }
  });
});
