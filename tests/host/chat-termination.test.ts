/**
 * Unit tests for `logChatTermination` — the unified "this chat ended badly"
 * helper. Every host-side termination site (spawn fail, dispatch error,
 * sandbox death, agent_response timeout/error, cleanup blowup) calls this
 * with structured `phase` / `reason` fields so an operator can `grep
 * chat_terminated` to find every chat-killing event in one place. Paired
 * with `src/host/chat-termination.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { logChatTermination } from '../../src/host/chat-termination.js';
import type { Logger } from '../../src/logger.js';

function fakeLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
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

describe('logChatTermination', () => {
  it('emits chat_terminated event with all required fields at error level', () => {
    const { logger, error } = fakeLogger();
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

  it('passes through optional exitCode + arbitrary detail fields without mutating them', () => {
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
    // The helper must not deep-clone or alter the caller's details object.
    expect(error.mock.calls[0]?.[1]?.details).toBe(details);
  });

  it('does not throw on edge-case inputs (empty reason, missing details)', () => {
    const { logger, error } = fakeLogger();
    expect(() => {
      logChatTermination(logger, { phase: 'cleanup', reason: '' });
    }).not.toThrow();
    expect(error).toHaveBeenCalledWith('chat_terminated', {
      phase: 'cleanup',
      reason: '',
    });
  });
});
