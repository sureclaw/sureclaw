/**
 * Retry with exponential backoff — reusable utility for fault-tolerant calls.
 *
 * Wraps any async function with configurable retry logic, exponential backoff,
 * jitter, and an optional predicate to classify errors as retryable or permanent.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'retry' });

export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial call). Default: 3. */
  maxRetries?: number;
  /** Initial backoff delay in ms. Default: 1000. */
  initialDelayMs?: number;
  /** Maximum backoff delay in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Backoff multiplier per attempt. Default: 2. */
  multiplier?: number;
  /** Add random jitter (0–50% of delay). Default: true. */
  jitter?: boolean;
  /** Return true if the error is retryable. Defaults to always retry. */
  isRetryable?: (err: unknown) => boolean;
  /** Label for log messages. */
  label?: string;
  /** AbortSignal to cancel retries early. */
  signal?: AbortSignal;
}

const DEFAULTS = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitter: true,
} as const;

/**
 * Execute `fn` with retry and exponential backoff.
 *
 * On each failure classified as retryable, waits an exponentially-growing
 * delay (with optional jitter) before the next attempt. Permanent errors
 * or exhausted retries throw immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions,
): Promise<T> {
  const maxRetries = opts?.maxRetries ?? DEFAULTS.maxRetries;
  const initialDelayMs = opts?.initialDelayMs ?? DEFAULTS.initialDelayMs;
  const maxDelayMs = opts?.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const multiplier = opts?.multiplier ?? DEFAULTS.multiplier;
  const jitter = opts?.jitter ?? DEFAULTS.jitter;
  const isRetryable = opts?.isRetryable ?? (() => true);
  const label = opts?.label ?? 'retry';
  const signal = opts?.signal;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error(`${label}: aborted`);
    }

    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxRetries || !isRetryable(err)) {
        break;
      }

      const baseDelay = Math.min(initialDelayMs * Math.pow(multiplier, attempt), maxDelayMs);
      const delay = jitter ? baseDelay + Math.random() * baseDelay * 0.5 : baseDelay;

      logger.debug('retry_backoff', {
        label,
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });

      await sleep(delay, signal);
    }
  }

  throw lastError;
}

/** Sleep that respects an AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when timer fires normally
      const origResolve = resolve;
      resolve = () => {
        signal.removeEventListener('abort', onAbort);
        origResolve();
      };
    }
  });
}
