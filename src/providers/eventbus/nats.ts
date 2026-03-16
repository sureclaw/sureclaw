// src/providers/eventbus/nats.ts — NATS JetStream EventBusProvider
//
// Publishes events to NATS subjects and subscribes via NATS for
// distributed event distribution across k8s pods.
//
// Subject mapping:
//   emit(event)                      → publish to events.{requestId} AND events.global
//   subscribeRequest(requestId, fn)  → subscribe to events.{requestId}
//   subscribe(fn)                    → subscribe to events.global

import type { Config } from '../../types.js';
import type { EventBusProvider, StreamEvent, EventListener } from './types.js';
import { getLogger } from '../../logger.js';
import { natsConnectOptions } from '../../utils/nats.js';

const logger = getLogger().child({ component: 'eventbus-nats' });

/** Maximum per-request subscribers (same as in-process event bus). */
const MAX_REQUEST_LISTENERS = 50;

/** Maximum global subscribers. */
const MAX_LISTENERS = 100;

/**
 * Serialize a StreamEvent to a NATS message payload.
 */
function serialize(event: StreamEvent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}

/**
 * Deserialize a NATS message payload to a StreamEvent.
 */
function deserialize(data: Uint8Array): StreamEvent | null {
  try {
    return JSON.parse(new TextDecoder().decode(data)) as StreamEvent;
  } catch {
    return null;
  }
}

/**
 * Create a NATS-backed EventBusProvider.
 *
 * Connects to a NATS server and uses publish/subscribe for event distribution.
 * Falls back gracefully on connection errors (logs + continues).
 */
export async function create(config: Config): Promise<EventBusProvider> {
  // Lazy import nats to avoid requiring it when using inprocess eventbus
  const natsModule = await import('nats');
  const { connect } = natsModule;

  const opts = natsConnectOptions('eventbus');

  let nc: Awaited<ReturnType<typeof connect>>;
  try {
    nc = await connect(opts);
    logger.info('nats_connected', { url: opts.servers });
  } catch (err) {
    logger.error('nats_connect_failed', { url: opts.servers, error: (err as Error).message });
    throw err;
  }

  // Track subscriptions for cleanup
  const subscriptions: ReturnType<typeof nc.subscribe>[] = [];

  // Global listeners — receive every event
  const globals: EventListener[] = [];

  // Per-request listeners — keyed by requestId
  const perRequest = new Map<string, EventListener[]>();

  // Subscribe to events.global for global listeners
  const globalSub = nc.subscribe('events.global');
  subscriptions.push(globalSub);

  // Process global subscription messages in background
  (async () => {
    for await (const msg of globalSub) {
      const event = deserialize(msg.data);
      if (!event) continue;
      for (const listener of [...globals]) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('event_listener_error', {
            type: event.type,
            error: (err as Error).message,
          });
        }
      }
    }
  })().catch(() => {}); // silently stop when subscription closes

  // Subscribe to events.* for per-request routing
  const requestSub = nc.subscribe('events.*');
  subscriptions.push(requestSub);

  (async () => {
    for await (const msg of requestSub) {
      // Extract requestId from subject: events.{requestId}
      const parts = msg.subject.split('.');
      if (parts.length < 2 || parts[0] !== 'events') continue;
      const requestId = parts.slice(1).join('.'); // handle dots in requestId
      if (requestId === 'global') continue; // handled by global sub

      const listeners = perRequest.get(requestId);
      if (!listeners || listeners.length === 0) continue;

      const event = deserialize(msg.data);
      if (!event) continue;

      for (const listener of [...listeners]) {
        try {
          listener(event);
        } catch (err) {
          logger.warn('event_listener_error', {
            type: event.type,
            requestId,
            error: (err as Error).message,
          });
        }
      }
    }
  })().catch(() => {});

  return {
    emit(event: StreamEvent): void {
      try {
        const data = serialize(event);
        // Publish to both request-specific and global subjects
        nc.publish(`events.${event.requestId}`, data);
        nc.publish('events.global', data);
      } catch (err) {
        logger.warn('nats_publish_error', {
          type: event.type,
          requestId: event.requestId,
          error: (err as Error).message,
        });
      }
    },

    subscribe(listener: EventListener): () => void {
      // Evict oldest if at capacity
      if (globals.length >= MAX_LISTENERS) {
        globals.shift();
        logger.warn('event_listener_evicted', {
          reason: 'max_listeners_reached',
          max: MAX_LISTENERS,
        });
      }

      globals.push(listener);

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const idx = globals.indexOf(listener);
        if (idx >= 0) globals.splice(idx, 1);
      };
    },

    subscribeRequest(requestId: string, listener: EventListener): () => void {
      let listeners = perRequest.get(requestId);
      if (!listeners) {
        listeners = [];
        perRequest.set(requestId, listeners);
      }

      if (listeners.length >= MAX_REQUEST_LISTENERS) {
        listeners.shift();
        logger.warn('request_listener_evicted', {
          requestId,
          reason: 'max_request_listeners_reached',
          max: MAX_REQUEST_LISTENERS,
        });
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
        if (arr.length === 0) perRequest.delete(requestId);
      };
    },

    listenerCount(): number {
      return globals.length;
    },

    close(): void {
      // Drain and close — fire-and-forget since close() is sync
      for (const sub of subscriptions) {
        sub.unsubscribe();
      }
      nc.drain().catch(() => {});
    },
  };
}
