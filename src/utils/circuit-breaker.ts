/**
 * Circuit breaker — prevents cascading failures by short-circuiting calls
 * to unhealthy services.
 *
 * States:
 *   CLOSED  → Normal operation. Failures increment the counter.
 *   OPEN    → Calls fail immediately without executing. Transitions to
 *             HALF_OPEN after the reset timeout.
 *   HALF_OPEN → One probe call is allowed. Success → CLOSED, failure → OPEN.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'circuit-breaker' });

export type CircuitState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** Time in ms before transitioning from OPEN to HALF_OPEN. Default: 30000. */
  resetTimeoutMs?: number;
  /** Optional label for logging. */
  label?: string;
  /** Return true if the error should count as a circuit-breaking failure. Defaults to always. */
  isFailure?: (err: unknown) => boolean;
}

const DEFAULTS = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
} as const;

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly label: string;
  private readonly isFailure: (err: unknown) => boolean;

  constructor(opts?: CircuitBreakerOptions) {
    this.failureThreshold = opts?.failureThreshold ?? DEFAULTS.failureThreshold;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? DEFAULTS.resetTimeoutMs;
    this.label = opts?.label ?? 'circuit';
    this.isFailure = opts?.isFailure ?? (() => true);
  }

  /** Current circuit state. */
  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  /** Number of consecutive failures. */
  getFailureCount(): number {
    return this.failureCount;
  }

  /**
   * Execute `fn` through the circuit breaker.
   *
   * - CLOSED: runs `fn` normally.
   * - OPEN: throws immediately without calling `fn`.
   * - HALF_OPEN: runs `fn` as a probe. Success → CLOSED, failure → OPEN.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    this.maybeTransitionToHalfOpen();

    if (this.state === 'open') {
      const remainingMs = this.resetTimeoutMs - (Date.now() - this.lastFailureTime);
      logger.debug('circuit_open', {
        label: this.label,
        remainingMs: Math.max(0, Math.round(remainingMs)),
      });
      throw new CircuitOpenError(this.label, Math.max(0, remainingMs));
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) {
        this.onFailure();
      }
      throw err;
    }
  }

  /** Manually reset the circuit to closed state. */
  reset(): void {
    if (this.state !== 'closed') {
      logger.debug('circuit_manual_reset', { label: this.label, fromState: this.state });
    }
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }

  private onSuccess(): void {
    if (this.state === 'half_open') {
      logger.debug('circuit_closed', { label: this.label, reason: 'probe_succeeded' });
    }
    this.state = 'closed';
    this.failureCount = 0;
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'half_open') {
      this.state = 'open';
      logger.debug('circuit_opened', { label: this.label, reason: 'probe_failed' });
    } else if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      logger.debug('circuit_opened', {
        label: this.label,
        reason: 'threshold_exceeded',
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
      });
    }
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'open' && Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
      this.state = 'half_open';
      logger.debug('circuit_half_open', { label: this.label });
    }
  }
}

/** Error thrown when the circuit is open and calls are being short-circuited. */
export class CircuitOpenError extends Error {
  public readonly retryAfterMs: number;

  constructor(label: string, retryAfterMs: number) {
    super(`Circuit breaker "${label}" is open — call rejected. Retry after ${Math.round(retryAfterMs)}ms.`);
    this.name = 'CircuitOpenError';
    this.retryAfterMs = retryAfterMs;
  }
}
