/**
 * Completion Queue — bounded concurrent execution with backpressure.
 *
 * Controls how many processCompletion() calls run in parallel. Requests
 * beyond max_concurrent wait in a FIFO queue. Requests beyond
 * max_queue_depth get rejected with 429.
 *
 * The queue is synchronous by design: enqueue() returns a promise that
 * resolves when a slot is available. The caller awaits that promise
 * before starting work, then calls done() when finished.
 */

import { getLogger } from '../logger.js';
import type { EventBus } from './event-bus.js';

const logger = getLogger().child({ component: 'completion-queue' });

export interface CompletionQueueConfig {
  /** Max parallel completions (default 5). */
  maxConcurrent: number;
  /** Max pending requests before rejection (default 50). */
  maxQueueDepth: number;
}

export interface QueueTicket {
  /** Resolves when a slot is available. Check abortSignal after await. */
  ready: Promise<void>;
  /** Call when the completion is done (success or error) to free the slot. */
  done: () => void;
  /** Position in queue at time of enqueue (0 = immediate start). */
  position: number;
}

interface Waiter {
  requestId: string;
  resolve: () => void;
  enqueuedAt: number;
}

export interface CompletionQueue {
  /**
   * Try to acquire a slot. Returns a ticket with a `ready` promise.
   * If the queue is full, returns null (caller should 429).
   */
  enqueue(requestId: string, signal?: AbortSignal): QueueTicket | null;
  /** Current number of active (executing) completions. */
  activeCount(): number;
  /** Current number of waiting (queued) requests. */
  waitingCount(): number;
  /** Drain: reject all waiters and prevent new enqueues. */
  drain(): void;
}

const DEFAULT_CONFIG: CompletionQueueConfig = {
  maxConcurrent: 5,
  maxQueueDepth: 50,
};

export function createCompletionQueue(
  config: Partial<CompletionQueueConfig> = {},
  eventBus?: EventBus,
): CompletionQueue {
  const maxConcurrent = config.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent;
  const maxQueueDepth = config.maxQueueDepth ?? DEFAULT_CONFIG.maxQueueDepth;

  let active = 0;
  const waiters: Waiter[] = [];
  let draining = false;

  function releaseSlot(): void {
    active--;
    logger.debug('slot_released', { active, waiting: waiters.length });

    // Wake the next waiter if any
    while (waiters.length > 0) {
      const next = waiters.shift()!;
      active++;
      logger.debug('slot_acquired_from_queue', {
        requestId: next.requestId,
        waitMs: Date.now() - next.enqueuedAt,
        active,
        waiting: waiters.length,
      });
      eventBus?.emit({
        type: 'queue.started',
        requestId: next.requestId,
        timestamp: Date.now(),
        data: { active, waiting: waiters.length, waitMs: Date.now() - next.enqueuedAt },
      });
      next.resolve();
      return;
    }
  }

  function enqueue(requestId: string, signal?: AbortSignal): QueueTicket | null {
    if (draining) {
      logger.debug('queue_draining', { requestId });
      return null;
    }

    // Fast path: slot available immediately
    if (active < maxConcurrent) {
      active++;
      let released = false;
      logger.debug('slot_acquired_immediate', { requestId, active, waiting: waiters.length });
      eventBus?.emit({
        type: 'queue.started',
        requestId,
        timestamp: Date.now(),
        data: { active, waiting: waiters.length, waitMs: 0 },
      });
      return {
        ready: Promise.resolve(),
        done: () => {
          if (released) return;
          released = true;
          eventBus?.emit({
            type: 'queue.done',
            requestId,
            timestamp: Date.now(),
            data: { active: active - 1, waiting: waiters.length },
          });
          releaseSlot();
        },
        position: 0,
      };
    }

    // Check queue depth
    if (waiters.length >= maxQueueDepth) {
      logger.warn('queue_full', { requestId, queueDepth: waiters.length, maxQueueDepth });
      eventBus?.emit({
        type: 'queue.rejected',
        requestId,
        timestamp: Date.now(),
        data: { reason: 'queue_full', queueDepth: waiters.length, maxQueueDepth },
      });
      return null;
    }

    // Queue the request
    const position = waiters.length + 1;
    let released = false;
    const enqueuedAt = Date.now();

    const ready = new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { requestId, resolve, enqueuedAt };
      waiters.push(waiter);

      logger.debug('queue_enqueued', { requestId, position, waiting: waiters.length });
      eventBus?.emit({
        type: 'queue.enqueued',
        requestId,
        timestamp: Date.now(),
        data: { position, waiting: waiters.length },
      });

      // If caller aborts while waiting, remove from queue
      if (signal) {
        const onAbort = () => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            logger.debug('queue_cancelled', { requestId, waiting: waiters.length });
            reject(new Error('Request cancelled while queued'));
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });

    return {
      ready,
      done: () => {
        if (released) return;
        released = true;
        eventBus?.emit({
          type: 'queue.done',
          requestId,
          timestamp: Date.now(),
          data: { active: active - 1, waiting: waiters.length },
        });
        releaseSlot();
      },
      position,
    };
  }

  function drain(): void {
    draining = true;
    // Reject all waiters
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      // resolve them so they can check draining state
      waiter.resolve();
    }
  }

  return {
    enqueue,
    activeCount: () => active,
    waitingCount: () => waiters.length,
    drain,
  };
}
