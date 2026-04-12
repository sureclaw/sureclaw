// src/providers/eventbus/types.ts — EventBusProvider interface
//
// Abstracts the EventBus behind a provider interface.
// Implementations: in-process pub/sub (local) and PostgreSQL LISTEN/NOTIFY (k8s).

import type { StreamEvent, EventListener } from '../../host/event-bus.js';

export type { StreamEvent, EventListener };

/**
 * EventBusProvider — typed pub/sub for real-time completion observability.
 *
 * Matches the existing EventBus interface from src/host/event-bus.ts,
 * plus a close() method for resource cleanup.
 */
export interface EventBusProvider {
  /** Fire-and-forget event emission. Never throws, never blocks. */
  emit(event: StreamEvent): void;

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void;

  /** Subscribe to events for a specific requestId only. Returns an unsubscribe function. */
  subscribeRequest(requestId: string, listener: EventListener): () => void;

  /** Current number of global subscribers. */
  listenerCount(): number;

  /** Release resources. No-op for in-process; closes connection for distributed implementations. */
  close(): void;
}
