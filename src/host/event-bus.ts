/**
 * Streaming Event Bus — typed pub/sub for real-time completion observability.
 *
 * Synchronous emit (fire-and-forget) so it never blocks the hot path.
 * Listeners that need async work should queue internally.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'event-bus' });

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface StreamEvent {
  /** Dot-namespaced event type (e.g. 'completion.start', 'llm.done'). */
  type: string;
  /** Ties this event to a specific completion request. */
  requestId: string;
  /** Unix timestamp (ms). */
  timestamp: number;
  /** Event-specific payload. No credentials, no full message content. */
  data: Record<string, unknown>;
}

export type EventListener = (event: StreamEvent) => void;

export interface EventBus {
  /** Fire-and-forget event emission. Never throws, never blocks. */
  emit(event: StreamEvent): void;
  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;
  /** Subscribe to events for a specific requestId only. Returns an unsubscribe function. */
  subscribeRequest(requestId: string, listener: EventListener): () => void;
  /** Current number of global subscribers. */
  listenerCount(): number;
}

// ═══════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════

/** Maximum global subscribers before oldest gets evicted. */
const MAX_LISTENERS = 100;

/** Maximum per-request subscribers. */
const MAX_REQUEST_LISTENERS = 50;

export function createEventBus(): EventBus {
  /** Global listeners — receive every event. */
  const globals: EventListener[] = [];

  /** Per-request listeners — keyed by requestId. */
  const perRequest = new Map<string, EventListener[]>();

  function emit(event: StreamEvent): void {
    // Global listeners
    for (const listener of globals) {
      try {
        listener(event);
      } catch (err) {
        logger.warn('event_listener_error', {
          type: event.type,
          error: (err as Error).message,
        });
      }
    }

    // Per-request listeners
    const requestListeners = perRequest.get(event.requestId);
    if (requestListeners) {
      for (const listener of requestListeners) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('event_listener_error', {
            type: event.type,
            requestId: event.requestId,
            error: (err as Error).message,
          });
        }
      }
    }
  }

  function subscribe(listener: EventListener): () => void {
    // Evict oldest if at capacity
    if (globals.length >= MAX_LISTENERS) {
      const evicted = globals.shift();
      if (evicted) {
        logger.warn('event_listener_evicted', {
          reason: 'max_listeners_reached',
          max: MAX_LISTENERS,
        });
      }
    }

    globals.push(listener);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const idx = globals.indexOf(listener);
      if (idx >= 0) globals.splice(idx, 1);
    };
  }

  function subscribeRequest(requestId: string, listener: EventListener): () => void {
    let listeners = perRequest.get(requestId);
    if (!listeners) {
      listeners = [];
      perRequest.set(requestId, listeners);
    }

    // Evict oldest per-request listener if at capacity
    if (listeners.length >= MAX_REQUEST_LISTENERS) {
      const evicted = listeners.shift();
      if (evicted) {
        logger.warn('request_listener_evicted', {
          requestId,
          reason: 'max_request_listeners_reached',
          max: MAX_REQUEST_LISTENERS,
        });
      }
    }

    listeners.push(listener);

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const arr = perRequest.get(requestId);
      if (!arr) return;
      const idx = arr.indexOf(listener);
      if (idx >= 0) arr.splice(idx, 1);
      // Clean up empty arrays to prevent Map growth
      if (arr.length === 0) perRequest.delete(requestId);
    };
  }

  function listenerCount(): number {
    return globals.length;
  }

  return { emit, subscribe, subscribeRequest, listenerCount };
}
