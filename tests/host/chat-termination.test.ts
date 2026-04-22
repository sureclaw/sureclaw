/**
 * Unit tests for `logChatTermination` — the unified "this chat ended badly"
 * helper. Every host-side termination site (spawn fail, dispatch error,
 * sandbox death, agent_response timeout/error, cleanup blowup) calls this
 * with structured `phase` / `reason` fields so an operator can `grep
 * chat_terminated` to find every chat-killing event in one place. Paired
 * with `src/host/chat-termination.ts`.
 *
 * Also tests `WaitFailureTracker`, which collects the most recent failure
 * cause across retry-loop attempts and emits `chat_terminated` exactly
 * once when retries are exhausted (Task 5 fix for per-attempt duplicates).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  logChatTermination,
  createWaitFailureTracker,
} from '../../src/host/chat-termination.js';
import type { Logger } from '../../src/logger.js';

function fakeLogger(): {
  logger: Logger;
  error: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const error = vi.fn();
  const warn = vi.fn();
  const info = vi.fn();
  const logger = {
    debug: vi.fn(),
    info,
    warn,
    error,
    fatal: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  return { logger, error, warn, info };
}

describe('logChatTermination', () => {
  it('emits chat_terminated event with all required fields at error level', () => {
    const { logger, error, warn, info } = fakeLogger();
    logChatTermination(logger, {
      phase: 'wait',
      reason: 'agent_response_timeout',
      sandboxId: 'ax-sandbox-abc123',
      details: { timeoutMs: 360000 },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('chat_terminated', {
      phase: 'wait',
      reason: 'agent_response_timeout',
      sandboxId: 'ax-sandbox-abc123',
      details: { timeoutMs: 360000 },
    });
    // Critical: chat_terminated MUST be at error level (operators alert on level >= 40).
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('accepts only the required fields (phase + reason)', () => {
    const { logger, error } = fakeLogger();
    logChatTermination(logger, {
      phase: 'dispatch',
      reason: 'fast_path_error',
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('chat_terminated', {
      phase: 'dispatch',
      reason: 'fast_path_error',
    });
  });

  it('passes through optional exitCode + arbitrary detail fields', () => {
    const { logger, error } = fakeLogger();
    const details = { error: 'boom', stderr: 'oops' };
    logChatTermination(logger, {
      phase: 'spawn',
      reason: 'sandbox_spawn_failed',
      exitCode: 137,
      details,
    });
    expect(error).toHaveBeenCalledWith('chat_terminated', {
      phase: 'spawn',
      reason: 'sandbox_spawn_failed',
      exitCode: 137,
      details,
    });
  });

  it('omits undefined optional fields from the emitted payload (no literal "undefined" keys)', () => {
    // Regression guard: callers pass `details: undefined` (or omit it), and a
    // naive spread would surface `details: undefined` in the JSON output as a
    // literal key. The helper must not introduce keys the caller didn't set.
    const { logger, error } = fakeLogger();
    logChatTermination(logger, {
      phase: 'cleanup',
      reason: 'cleanup_failed',
      // sandboxId, exitCode, details all omitted
    });
    const payload = error.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ phase: 'cleanup', reason: 'cleanup_failed' });
    expect(Object.keys(payload)).not.toContain('details');
    expect(Object.keys(payload)).not.toContain('sandboxId');
    expect(Object.keys(payload)).not.toContain('exitCode');
  });
});

describe('WaitFailureTracker', () => {
  // Emits chat_terminated EXACTLY ONCE per terminated chat — never per attempt.
  // The retry loop in server-completions.ts records each attempt's failure via
  // the tracker, then calls emit() once when retries are exhausted (the
  // `agent_failed` branch). A chat that fails on attempt 0 but succeeds on
  // attempt 1 must produce ZERO chat_terminated events.

  it('emits zero chat_terminated events when no failure was recorded', () => {
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();
    // Caller succeeded — never recorded any failure. emit() should be a no-op
    // because there's nothing to terminate on. (In practice the retry loop
    // wouldn't call emit at all on success, but defensiveness is cheap.)
    tracker.emit(logger, { phase: 'wait', sandboxId: 'pod-a' });
    expect(error).not.toHaveBeenCalled();
  });

  it('emits exactly one chat_terminated event on terminal exhaustion regardless of retry count', () => {
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();

    // Simulate three failed attempts in a retry loop.
    tracker.record({ reason: 'agent_response_error', details: { error: 'EPIPE' } });
    tracker.record({ reason: 'agent_response_error', details: { error: 'ECONNRESET' } });
    tracker.record({ reason: 'agent_response_timeout', details: { error: 'agent_response timeout' } });

    // Retries exhausted — terminal point fires emit() once.
    tracker.emit(logger, {
      phase: 'wait',
      sandboxId: 'ax-sandbox-xyz',
      exitCode: 1,
      details: { attempt: 3, maxRetries: 2 },
    });

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('chat_terminated', expect.objectContaining({
      phase: 'wait',
      // The MOST RECENT failure cause wins — that's what actually killed the chat.
      reason: 'agent_response_timeout',
      sandboxId: 'ax-sandbox-xyz',
      exitCode: 1,
    }));
    // Details merge: caller-supplied terminal details override / supplement
    // the per-attempt details.
    const payload = error.mock.calls[0]?.[1] as { details: Record<string, unknown> };
    expect(payload.details).toMatchObject({
      error: 'agent_response timeout',
      attempt: 3,
      maxRetries: 2,
    });
  });

  it('emits zero events when caller succeeds after a transient failure (record-but-no-emit)', () => {
    // The actual happy-path-after-retry pattern: record the transient failure,
    // then the next attempt succeeds, and the loop breaks BEFORE reaching the
    // terminal emit() call. This proves the tracker doesn't auto-emit.
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();
    tracker.record({ reason: 'agent_response_error', details: { error: 'EPIPE' } });
    // ...next attempt succeeds, loop breaks without calling emit()...
    expect(error).not.toHaveBeenCalled();
  });

  it('emitTerminal: recorded per-attempt reason wins over the supplied terminal reason', () => {
    // The wired-up retry loop calls emitTerminal at the agent_failed branch
    // with reason: 'agent_failed' as a defensive fallback. When a cause was
    // actually recorded (timeout, response_error), THAT specific cause is
    // what killed the chat — it must surface in the chat_terminated event,
    // not the generic 'agent_failed' fallback.
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();
    tracker.record({ reason: 'agent_response_timeout', details: { error: 'agent_response timeout' } });
    tracker.emitTerminal(logger, {
      phase: 'wait',
      reason: 'agent_failed',
      sandboxId: 'pod-x',
      exitCode: 1,
      details: { attempt: 2, maxRetries: 2 },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({
      phase: 'wait',
      reason: 'agent_response_timeout',  // recorded cause, not 'agent_failed'
      sandboxId: 'pod-x',
      exitCode: 1,
      details: { error: 'agent_response timeout', attempt: 2, maxRetries: 2 },
    });
  });

  it('falls back to a generic reason when terminal fires without any recorded cause', () => {
    // Defensive: if agent_failed fires on a path that never recorded a
    // wait-phase failure (e.g. agent crashed cleanly with non-zero exit but
    // never errored on the response promise), emit() still produces a useful
    // chat_terminated rather than throwing or logging an empty reason.
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();
    tracker.emitTerminal(logger, {
      phase: 'wait',
      reason: 'agent_failed',
      exitCode: 137,
      details: { stderrPreview: 'OOMKilled' },
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('chat_terminated', {
      phase: 'wait',
      reason: 'agent_failed',
      exitCode: 137,
      details: { stderrPreview: 'OOMKilled' },
    });
  });
});
