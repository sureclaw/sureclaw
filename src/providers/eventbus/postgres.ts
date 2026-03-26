// src/providers/eventbus/postgres.ts — Postgres LISTEN/NOTIFY EventBusProvider
//
// Uses Postgres LISTEN/NOTIFY for real-time event distribution.
// Each event is published to two channels:
//   events_global    — all subscribers receive it
//   events_{reqId}   — only per-request subscribers for that requestId
//
// NOTIFY payload limit is 8KB. SSE events are small JSON, well under this.

import type { Config } from '../../types.js';
import type { EventBusProvider, StreamEvent, EventListener } from './types.js';
import { createRequire } from 'node:module';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'eventbus-postgres' });

const MAX_REQUEST_LISTENERS = 50;
const MAX_LISTENERS = 100;

/** Sanitize a requestId for use as a Postgres channel name suffix. */
function sanitizeChannel(requestId: string): string {
  return requestId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);
}

export async function create(_config: Config): Promise<EventBusProvider> {
  const req = createRequire(import.meta.url);
  const { Client } = req('pg');

  const connectionString = process.env.POSTGRESQL_URL
    ?? process.env.DATABASE_URL
    ?? 'postgresql://localhost:5432/ax';

  // Dedicated connection for LISTEN (cannot share with query pool —
  // pg LISTEN requires a persistent, non-pooled connection).
  const listenClient = new Client({ connectionString });
  await listenClient.connect();

  // Separate client for NOTIFY (can use any connection)
  const notifyClient = new Client({ connectionString });
  await notifyClient.connect();

  const globals: EventListener[] = [];
  const perRequest = new Map<string, EventListener[]>();
  const activeChannels = new Set<string>();

  // Listen on global channel
  await listenClient.query('LISTEN events_global');

  // Route incoming notifications to the right listeners
  listenClient.on('notification', (msg: { channel: string; payload?: string }) => {
    if (!msg.payload) return;
    let event: StreamEvent;
    try {
      event = JSON.parse(msg.payload) as StreamEvent;
    } catch {
      return;
    }

    if (msg.channel === 'events_global') {
      for (const listener of [...globals]) {
        try { listener(event); } catch (err) {
          logger.warn('event_listener_error', { type: event.type, error: (err as Error).message });
        }
      }
    } else {
      // events_{requestId}
      const reqId = msg.channel.replace(/^events_/, '');
      const listeners = perRequest.get(reqId);
      if (!listeners) return;
      for (const listener of [...listeners]) {
        try { listener(event); } catch (err) {
          logger.warn('event_listener_error', { type: event.type, requestId: reqId, error: (err as Error).message });
        }
      }
    }
  });

  logger.info('postgres_eventbus_connected');

  return {
    emit(event: StreamEvent): void {
      const payload = JSON.stringify(event);
      if (payload.length > 7900) {
        logger.warn('event_payload_too_large', { type: event.type, bytes: payload.length });
        return;
      }
      const escaped = payload.replace(/'/g, "''");
      notifyClient.query(`NOTIFY events_global, '${escaped}'`).catch((err: Error) => {
        logger.warn('notify_failed', { channel: 'events_global', error: err.message });
      });
      const channel = `events_${sanitizeChannel(event.requestId)}`;
      notifyClient.query(`NOTIFY ${channel}, '${escaped}'`).catch((err: Error) => {
        logger.warn('notify_failed', { channel, error: err.message });
      });
    },

    subscribe(listener: EventListener): () => void {
      if (globals.length >= MAX_LISTENERS) {
        globals.shift();
        logger.warn('event_listener_evicted', { reason: 'max_listeners_reached', max: MAX_LISTENERS });
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
      const channel = sanitizeChannel(requestId);
      let listeners = perRequest.get(channel);
      if (!listeners) {
        listeners = [];
        perRequest.set(channel, listeners);
      }

      if (listeners.length >= MAX_REQUEST_LISTENERS) {
        listeners.shift();
      }
      listeners.push(listener);

      // LISTEN on this channel if not already
      if (!activeChannels.has(channel)) {
        activeChannels.add(channel);
        listenClient.query(`LISTEN events_${channel}`).catch((err: Error) => {
          logger.warn('listen_failed', { channel, error: err.message });
        });
      }

      let removed = false;
      return () => {
        if (removed) return;
        removed = true;
        const arr = perRequest.get(channel);
        if (!arr) return;
        const idx = arr.indexOf(listener);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) {
          perRequest.delete(channel);
          activeChannels.delete(channel);
          listenClient.query(`UNLISTEN events_${channel}`).catch(() => {});
        }
      };
    },

    listenerCount(): number {
      return globals.length;
    },

    close(): void {
      listenClient.end().catch(() => {});
      notifyClient.end().catch(() => {});
    },
  };
}
