import { describe, test, expect } from 'vitest';
import { isTransientAgentFailure } from '../../src/host/server-completions.js';

describe('isTransientAgentFailure', () => {
  // ── Permanent failures (should NOT retry) ──

  test('auth error 401 is permanent', () => {
    expect(isTransientAgentFailure(1, 'API returned 401 Unauthorized')).toBe(false);
  });

  test('auth error 403 is permanent', () => {
    expect(isTransientAgentFailure(1, 'API returned 403 Forbidden')).toBe(false);
  });

  test('invalid api key is permanent', () => {
    expect(isTransientAgentFailure(1, 'Invalid API key provided')).toBe(false);
  });

  test('no api credentials is permanent', () => {
    expect(isTransientAgentFailure(1, 'No API credentials configured')).toBe(false);
  });

  test('bad request 400 is permanent', () => {
    expect(isTransientAgentFailure(1, 'HTTP 400 Bad Request: invalid model')).toBe(false);
  });

  test('validation failed is permanent', () => {
    expect(isTransientAgentFailure(1, 'Validation failed for action "llm_call"')).toBe(false);
  });

  test('timeout/sigkill is permanent (already used full budget)', () => {
    expect(isTransientAgentFailure(137, 'Process timed out and received SIGKILL')).toBe(false);
  });

  test('generic timeout is permanent', () => {
    expect(isTransientAgentFailure(1, 'IPC call timed out after 30000ms')).toBe(false);
  });

  // ── Transient failures (should retry) ──

  test('OOM kill (exit 137) without timeout stderr is transient', () => {
    // 137 = 128+9 (SIGKILL). If stderr doesn't mention timeout → transient (OOM, not timeout).
    expect(isTransientAgentFailure(137, 'Killed')).toBe(true);
    expect(isTransientAgentFailure(137, 'out of memory')).toBe(true);
  });

  test('exit 137 with timeout stderr is permanent', () => {
    // Same signal kill but stderr says "timed out" → sandbox used its full budget, don't retry
    expect(isTransientAgentFailure(137, 'Process timed out')).toBe(false);
  });

  test('SEGV (exit 139) is transient', () => {
    expect(isTransientAgentFailure(139, 'segmentation fault')).toBe(true);
  });

  test('signal exit (128+N) range is transient', () => {
    expect(isTransientAgentFailure(130, 'Interrupt')).toBe(true); // SIGINT
    expect(isTransientAgentFailure(134, 'Aborted')).toBe(true);  // SIGABRT
    expect(isTransientAgentFailure(143, 'Terminated')).toBe(true); // SIGTERM
  });

  test('ECONNRESET in stderr is transient', () => {
    expect(isTransientAgentFailure(1, 'Error: read ECONNRESET')).toBe(true);
  });

  test('ECONNREFUSED in stderr is transient', () => {
    expect(isTransientAgentFailure(1, 'connect ECONNREFUSED 127.0.0.1:80')).toBe(true);
  });

  test('EPIPE in stderr is transient', () => {
    expect(isTransientAgentFailure(1, 'write EPIPE')).toBe(true);
  });

  test('socket hang up is transient', () => {
    expect(isTransientAgentFailure(1, 'socket hang up')).toBe(true);
  });

  test('spawn error is transient', () => {
    expect(isTransientAgentFailure(1, 'spawn tsx ENOENT — spawn error')).toBe(true);
  });

  test('ENOMEM is transient', () => {
    expect(isTransientAgentFailure(1, 'Error: spawn tsx ENOMEM')).toBe(true);
  });

  test('cannot allocate memory is transient', () => {
    expect(isTransientAgentFailure(1, 'Cannot allocate memory')).toBe(true);
  });

  test('unknown non-zero exit with generic stderr is transient', () => {
    expect(isTransientAgentFailure(1, 'some random error we have never seen')).toBe(true);
  });

  test('exit 0 is not transient', () => {
    expect(isTransientAgentFailure(0, '')).toBe(false);
  });
});
