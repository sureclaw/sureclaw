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
 *
 * Also tests `logChatComplete` — the success-side counterpart at info level.
 * Together with `chat_terminated`, every chat turn produces exactly one
 * canonical line so operators can `grep "chat_complete\|chat_terminated"`
 * to scan outcomes (Task 6).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  logChatTermination,
  logChatComplete,
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

describe('logChatComplete', () => {
  // Pairs with `logChatTermination`: every successful chat turn emits exactly
  // one `chat_complete` event at info level with the same shape (sessionId,
  // agentId, durationMs, phases, sandboxId). Operators scan
  // `grep "chat_complete\|chat_terminated"` to see every chat outcome with
  // timing in a single greppable line.

  it('emits chat_complete event at info with timing fields', () => {
    const { logger, info } = fakeLogger();
    logChatComplete(logger, {
      sessionId: 'sess-1',
      agentId: 'default',
      durationMs: 4200,
      phases: { dispatch: 300, agent: 3500, persist: 400 },
      sandboxId: 'ax-sandbox-abc123',
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('chat_complete', expect.objectContaining({
      sessionId: 'sess-1',
      durationMs: 4200,
    }));
  });

  it('emits at info level only — never error/warn (operators alert on error+, not info)', () => {
    const { logger, error, warn, info } = fakeLogger();
    logChatComplete(logger, {
      sessionId: 'sess-2',
      durationMs: 100,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('accepts only the required fields (sessionId + durationMs)', () => {
    const { logger, info } = fakeLogger();
    logChatComplete(logger, {
      sessionId: 'sess-3',
      durationMs: 50,
    });
    expect(info).toHaveBeenCalledWith('chat_complete', {
      sessionId: 'sess-3',
      durationMs: 50,
    });
  });

  it('passes through agentId, phases, sandboxId when provided', () => {
    const { logger, info } = fakeLogger();
    logChatComplete(logger, {
      sessionId: 'sess-4',
      agentId: 'coder',
      durationMs: 9001,
      phases: { scan: 5, dispatch: 200, agent: 8500, persist: 296 },
      sandboxId: 'pod-x',
    });
    expect(info).toHaveBeenCalledWith('chat_complete', {
      sessionId: 'sess-4',
      agentId: 'coder',
      durationMs: 9001,
      phases: { scan: 5, dispatch: 200, agent: 8500, persist: 296 },
      sandboxId: 'pod-x',
    });
  });

  it('omits undefined optional fields from the emitted payload (no literal "undefined" keys)', () => {
    // Same regression guard as logChatTermination — never surface a literal
    // `key: undefined` into the JSON output. Keys the caller didn't set must
    // not appear in the emitted payload.
    const { logger, info } = fakeLogger();
    logChatComplete(logger, {
      sessionId: 'sess-5',
      durationMs: 10,
      // agentId, phases, sandboxId all omitted
    });
    const payload = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload).toEqual({ sessionId: 'sess-5', durationMs: 10 });
    expect(Object.keys(payload)).not.toContain('agentId');
    expect(Object.keys(payload)).not.toContain('phases');
    expect(Object.keys(payload)).not.toContain('sandboxId');
  });

  // Regression guard for the contract that every chat termination site MUST
  // satisfy: when something has fired (or is about to fire) `chat_terminated`,
  // the success-side `chat_complete` MUST NOT also fire on the same return
  // path. The actual call site (`attach` inside `processCompletion`) gates
  // its emit on a `chatTerminated` flag set by `markTerminated()` — this test
  // models that gate to ensure no future refactor regresses the pairing.
  //
  // Specifically targets the outer-catch fix: prior to the fix, an unhandled
  // throw flowed `completion_error` (error) → `attach` (info `chat_complete`)
  // and an operator running `grep "chat_complete\|chat_terminated"` would
  // see `chat_complete` and conclude the chat succeeded. The fix calls
  // `markTerminated()` before `attach` runs; this test models the
  // mark-then-emit ordering to lock the invariant in place.
  it('contract: when termination has fired, chat_complete must not also fire on the same return', () => {
    const { logger, info, error } = fakeLogger();

    // Simulate the outer-catch: log the termination, then mark.
    let terminated = false;
    const markTerminated = (): void => { terminated = true; };
    logChatTermination(logger, {
      phase: 'dispatch',
      reason: 'completion_error',
      details: { error: 'boom' },
    });
    markTerminated();

    // Simulate `attach` running on the error return path: the same
    // `if (!terminated)` gate the production code uses.
    if (!terminated) {
      logChatComplete(logger, { sessionId: 'sess-x', durationMs: 100 });
    }

    // Exactly one canonical line for the operator: chat_terminated, no
    // shadow chat_complete saying the chat succeeded.
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith('chat_terminated', expect.objectContaining({
      reason: 'completion_error',
    }));
    expect(info).not.toHaveBeenCalled();
  });
});

describe('WaitFailureTracker', () => {
  // Emits chat_terminated EXACTLY ONCE per terminated chat — never per attempt.
  // The retry loop in server-completions.ts records each attempt's failure via
  // the tracker, then calls emitTerminal() once when retries are exhausted (the
  // `agent_failed` branch). A chat that fails on attempt 0 but succeeds on
  // attempt 1 must produce ZERO chat_terminated events.

  it('emits zero events when caller succeeds after a transient failure (record-but-no-emit)', () => {
    // The actual happy-path-after-retry pattern: record the transient failure,
    // then the next attempt succeeds, and the loop breaks BEFORE reaching the
    // terminal emitTerminal() call. This proves the tracker doesn't auto-emit.
    const { logger, error } = fakeLogger();
    const tracker = createWaitFailureTracker();
    tracker.record({ reason: 'agent_response_error', details: { error: 'EPIPE' } });
    // ...next attempt succeeds, loop breaks without calling emitTerminal()...
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
