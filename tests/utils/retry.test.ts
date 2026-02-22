import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../src/utils/retry.js';

describe('withRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('retries on failure and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    // Run with real timers for this test since delays are actual waits
    vi.useRealTimers();

    const result = await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 10,
      jitter: false,
    });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

    vi.useRealTimers();

    await expect(
      withRetry(fn, { maxRetries: 2, initialDelayMs: 10, jitter: false }),
    ).rejects.toThrow('persistent failure');

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  test('does not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('auth 401'));

    vi.useRealTimers();

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 10,
        isRetryable: (err) => !(err instanceof Error && err.message.includes('401')),
      }),
    ).rejects.toThrow('auth 401');

    expect(fn).toHaveBeenCalledTimes(1); // No retries for permanent errors
  });

  test('respects maxDelayMs cap', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    vi.useRealTimers();

    const start = Date.now();
    await withRetry(fn, {
      maxRetries: 1,
      initialDelayMs: 100,
      maxDelayMs: 50, // Cap should be respected
      jitter: false,
    });
    const elapsed = Date.now() - start;

    // Should have waited around 50ms (the cap), not 100ms
    expect(elapsed).toBeLessThan(100);
  });

  test('aborts when signal is already aborted', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const controller = new AbortController();
    controller.abort();

    vi.useRealTimers();

    await expect(
      withRetry(fn, { signal: controller.signal, label: 'test' }),
    ).rejects.toThrow('aborted');

    expect(fn).not.toHaveBeenCalled();
  });

  test('aborts mid-retry when signal fires', async () => {
    const controller = new AbortController();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');

    vi.useRealTimers();

    // Abort after a short delay (before retry completes its backoff)
    setTimeout(() => controller.abort(), 20);

    await expect(
      withRetry(fn, {
        maxRetries: 3,
        initialDelayMs: 5000, // Long delay — will be interrupted by abort
        signal: controller.signal,
        jitter: false,
      }),
    ).rejects.toThrow('Aborted');
  });

  test('with zero maxRetries, no retries happen', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    vi.useRealTimers();

    await expect(
      withRetry(fn, { maxRetries: 0 }),
    ).rejects.toThrow('fail');

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('applies exponential backoff with multiplier', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'))
      .mockResolvedValue('ok');

    vi.useRealTimers();

    const start = Date.now();
    await withRetry(fn, {
      maxRetries: 3,
      initialDelayMs: 50,
      multiplier: 2,
      jitter: false,
    });
    const elapsed = Date.now() - start;

    // First retry: 50ms, second retry: 100ms. Total ~150ms.
    expect(elapsed).toBeGreaterThanOrEqual(100); // At least 150ms minus some tolerance
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
