import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from '../../src/utils/circuit-breaker.js';

describe('CircuitBreaker', () => {
  test('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });

  test('passes calls through when closed', async () => {
    const cb = new CircuitBreaker();
    const result = await cb.call(async () => 'ok');
    expect(result).toBe('ok');
    expect(cb.getState()).toBe('closed');
  });

  test('counts failures but stays closed below threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(cb.getFailureCount()).toBe(1);
    expect(cb.getState()).toBe('closed');

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow('fail');
    expect(cb.getFailureCount()).toBe(2);
    expect(cb.getState()).toBe('closed');
  });

  test('opens circuit after reaching failure threshold', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();

    expect(cb.getState()).toBe('open');
    expect(cb.getFailureCount()).toBe(2);
  });

  test('rejects calls immediately when open', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    // Trip the circuit
    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    // Subsequent calls should be rejected without calling fn
    const fn = vi.fn();
    await expect(cb.call(fn)).rejects.toThrow(CircuitOpenError);
    expect(fn).not.toHaveBeenCalled();
  });

  test('CircuitOpenError has retryAfterMs', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5000 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();

    try {
      await cb.call(async () => 'never');
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError);
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
      expect((err as CircuitOpenError).retryAfterMs).toBeLessThanOrEqual(5000);
    }
  });

  test('transitions to half_open after reset timeout', async () => {
    vi.useFakeTimers();

    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    // Trip the circuit
    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    // Advance time past the reset timeout
    vi.advanceTimersByTime(1001);

    expect(cb.getState()).toBe('half_open');

    vi.useRealTimers();
  });

  test('half_open: success closes the circuit', async () => {
    vi.useFakeTimers();

    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    vi.advanceTimersByTime(1001);

    expect(cb.getState()).toBe('half_open');

    // Successful probe
    const result = await cb.call(async () => 'recovered');
    expect(result).toBe('recovered');
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);

    vi.useRealTimers();
  });

  test('half_open: failure reopens the circuit', async () => {
    vi.useFakeTimers();

    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    vi.advanceTimersByTime(1001);

    expect(cb.getState()).toBe('half_open');

    // Failed probe
    await expect(cb.call(async () => { throw new Error('still broken'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    vi.useRealTimers();
  });

  test('success resets failure count', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getFailureCount()).toBe(2);

    // One success resets the counter
    await cb.call(async () => 'ok');
    expect(cb.getFailureCount()).toBe(0);
    expect(cb.getState()).toBe('closed');
  });

  test('manual reset works', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });

    await expect(cb.call(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');

    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);

    // Should work again
    const result = await cb.call(async () => 'ok');
    expect(result).toBe('ok');
  });

  test('isFailure predicate controls which errors count', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      isFailure: (err) => {
        // Only count 500 errors, not 400 errors
        return err instanceof Error && err.message.includes('500');
      },
    });

    // 400 error should not trip the circuit
    await expect(cb.call(async () => { throw new Error('400 bad request'); })).rejects.toThrow();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);

    // 500 error should trip the circuit
    await expect(cb.call(async () => { throw new Error('500 server error'); })).rejects.toThrow();
    expect(cb.getState()).toBe('open');
  });

  test('passes through non-failure errors without opening circuit', async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      isFailure: () => false,
    });

    // Error thrown but isFailure returns false — should not trip
    await expect(cb.call(async () => { throw new Error('nope'); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error('nope'); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error('nope'); })).rejects.toThrow();

    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });
});
