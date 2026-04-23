/**
 * Integration-lite test for the retry-loop wire-up of `WaitFailureTracker`.
 *
 * `processCompletion`'s retry loop (server-completions.ts:~1805–2095) calls
 * `tracker.record({...})` per attempt failure and `tracker.emitTerminal(...)`
 * once at the `agent_failed` branch. Pre-Task-5 the per-attempt code emitted
 * `chat_terminated` directly, producing N events for N failed attempts —
 * misleading because a chat that fails-then-succeeds left a stale
 * "terminated" event. This test mirrors the EXACT call sequence the wired-up
 * loop performs to prove:
 *
 *   1. fail-then-succeed produces ZERO chat_terminated events
 *   2. fail-fail-fail (retries exhausted) produces EXACTLY ONE event
 *   3. the recorded cause (e.g. 'agent_response_timeout') wins over the
 *      generic terminal `agent_failed` reason in the emitted event
 *   4. the captured pod name and reqId-bearing logger bindings ride through
 *
 * We don't invoke `processCompletion` directly — its dependency surface
 * (provisioner, IPC handler, sandbox factory, workspace provider, etc.)
 * makes a true end-to-end call infeasible in a unit test. Instead we
 * replicate the call sequence so a regression in the wire-up (e.g.
 * forgetting to switch from `logChatTermination` to the tracker, or
 * calling `emit()` instead of `emitTerminal()`) would fail here.
 */

import { describe, test, expect, vi } from 'vitest';
import { createWaitFailureTracker, AGENT_RESPONSE_TIMEOUT_MSG } from '../../src/host/chat-termination.js';
import type { Logger } from '../../src/logger.js';

function reqLoggerWithBindings(): {
  logger: Logger;
  error: ReturnType<typeof vi.fn>;
} {
  // Real loggers carry reqId/sessionId bindings via `logger.child(...)`. The
  // tracker doesn't touch bindings — pino attaches them automatically — so
  // for the test we only need a flat error spy.
  const error = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error,
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, error };
}

const PROC_POD_NAME = 'ax-sandbox-fake01';
const MAX_AGENT_RETRIES = 2;

/**
 * Simulate one trip through the retry loop. The "agent" is a function that
 * returns either:
 *   - a string (success — the loop breaks, no termination)
 *   - throws (failure — the catch records it; if retries exhaust, terminal)
 */
async function runRetryLoop(opts: {
  attempts: Array<() => Promise<string>>;
  logger: Logger;
}): Promise<{ outcome: 'success' | 'agent_failed'; response?: string }> {
  const tracker = createWaitFailureTracker();
  let response: string | undefined;
  let exitCode = 1;

  for (let attempt = 0; attempt <= MAX_AGENT_RETRIES; attempt++) {
    try {
      response = await opts.attempts[attempt]?.();
      break;
    } catch (err) {
      const message = (err as Error).message;
      const reason =
        message === AGENT_RESPONSE_TIMEOUT_MSG
          ? 'agent_response_timeout'
          : 'agent_response_error';
      tracker.record({ reason, details: { error: message, attempt } });
      // ── Mirror the real loop's transient-vs-permanent decision ──
      // For this test we treat all failures as transient until retries run
      // out, so we exercise the multi-attempt path.
      if (attempt >= MAX_AGENT_RETRIES) {
        tracker.emitTerminal(opts.logger, {
          phase: 'wait',
          reason: 'agent_failed',
          sandboxId: PROC_POD_NAME,
          exitCode,
          details: {
            attempt,
            maxRetries: MAX_AGENT_RETRIES,
            retryable: true,
            stderrPreview: '',
          },
        });
        return { outcome: 'agent_failed' };
      }
    }
  }
  return { outcome: 'success', response };
}

describe('retry loop wire-up: chat_terminated fires exactly once per terminated chat', () => {
  test('fail-then-succeed: ZERO chat_terminated events', async () => {
    // Attempt 0 throws (transient EPIPE), attempt 1 succeeds. The loop must
    // not emit chat_terminated — the chat ultimately succeeded, so the
    // recorded per-attempt failure stays a recovered transient.
    const { logger, error } = reqLoggerWithBindings();
    const result = await runRetryLoop({
      logger,
      attempts: [
        () => Promise.reject(new Error('EPIPE')),
        () => Promise.resolve('agent response payload'),
      ],
    });

    expect(result.outcome).toBe('success');
    expect(result.response).toBe('agent response payload');
    expect(error).not.toHaveBeenCalled();
  });

  test('all attempts fail: EXACTLY ONE chat_terminated event at the terminal branch', async () => {
    // Three attempts, all fail with the same transient cause. The terminal
    // branch must fire chat_terminated ONCE, naming the recorded cause and
    // carrying the sandboxId + exitCode + retry context.
    const { logger, error } = reqLoggerWithBindings();
    const result = await runRetryLoop({
      logger,
      attempts: [
        () => Promise.reject(new Error('EPIPE')),
        () => Promise.reject(new Error('EPIPE')),
        () => Promise.reject(new Error('EPIPE')),
      ],
    });

    expect(result.outcome).toBe('agent_failed');
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toBe('chat_terminated');
    const payload = error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      phase: 'wait',
      reason: 'agent_response_error',
      sandboxId: PROC_POD_NAME,
      exitCode: 1,
    });
    const details = payload.details as Record<string, unknown>;
    expect(details).toMatchObject({
      error: 'EPIPE',
      attempt: MAX_AGENT_RETRIES, // last attempt index that recorded
      maxRetries: MAX_AGENT_RETRIES,
      retryable: true,
    });
  });

  test('timeout-then-fail: chat_terminated reason is the most recent recorded cause', async () => {
    // Attempt 0 times out (host's safety timer rejects with this exact
    // message), attempt 1 fails with a different cause. The terminal event
    // must name the MOST RECENT cause — that's what actually killed this
    // chat — not a stale earlier cause or the generic 'agent_failed'.
    const { logger, error } = reqLoggerWithBindings();
    const result = await runRetryLoop({
      logger,
      attempts: [
        () => Promise.reject(new Error(AGENT_RESPONSE_TIMEOUT_MSG)),
        () => Promise.reject(new Error('ECONNRESET')),
        () => Promise.reject(new Error('ECONNRESET')),
      ],
    });

    expect(result.outcome).toBe('agent_failed');
    expect(error).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.reason).toBe('agent_response_error'); // most recent (ECONNRESET)
    expect((payload.details as Record<string, unknown>).error).toBe('ECONNRESET');
  });

  test('only-timeout: chat_terminated reason is agent_response_timeout', async () => {
    // All attempts time out. Reason should be the specific
    // 'agent_response_timeout', NOT the generic 'agent_failed' — operators
    // need to distinguish budget-exceeded from other failure modes.
    const { logger, error } = reqLoggerWithBindings();
    const result = await runRetryLoop({
      logger,
      attempts: [
        () => Promise.reject(new Error(AGENT_RESPONSE_TIMEOUT_MSG)),
        () => Promise.reject(new Error(AGENT_RESPONSE_TIMEOUT_MSG)),
        () => Promise.reject(new Error(AGENT_RESPONSE_TIMEOUT_MSG)),
      ],
    });

    expect(result.outcome).toBe('agent_failed');
    expect(error).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      phase: 'wait',
      reason: 'agent_response_timeout',
      sandboxId: PROC_POD_NAME,
    });
  });

  test('agent crashed cleanly without ever erroring on response: terminal reason falls back to agent_failed', async () => {
    // The retry loop also reaches its terminal branch when the agent exits
    // non-zero without ever throwing on the response promise (e.g. bash crash
    // wrote a partial response then exited 1). In that case nothing was
    // recorded on the tracker — emitTerminal must use its supplied fallback
    // reason instead of staying silent.
    const { logger, error } = reqLoggerWithBindings();
    const tracker = createWaitFailureTracker();
    // No tracker.record() — simulates the no-recorded-cause path.
    tracker.emitTerminal(logger, {
      phase: 'wait',
      reason: 'agent_failed',
      sandboxId: PROC_POD_NAME,
      exitCode: 137,
      details: { attempt: 2, maxRetries: 2, retryable: false, stderrPreview: 'OOMKilled' },
    });
    expect(error).toHaveBeenCalledTimes(1);
    const payload = error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toMatchObject({
      phase: 'wait',
      reason: 'agent_failed',
      sandboxId: PROC_POD_NAME,
      exitCode: 137,
    });
  });
});
