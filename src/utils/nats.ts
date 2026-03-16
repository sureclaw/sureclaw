// src/utils/nats.ts — Centralized NATS connection helper.
//
// Provides consistent connection options across all NATS connect() callers.
// Supports static NATS user authentication via NATS_USER / NATS_PASS env vars.

/**
 * NATS connection options (matches nats.ConnectionOptions shape).
 * Defined here to avoid importing the nats package at module level.
 */
export interface NatsConnectOptions {
  servers: string;
  name: string;
  user?: string;
  pass?: string;
  reconnect: boolean;
  maxReconnectAttempts: number;
  reconnectTimeWait: number;
}

/**
 * Build standardized NATS connection options.
 *
 * @param name — short identifier for the connection (e.g. "host", "ipc-handler").
 *               Will be prefixed with "ax-" and suffixed with PID.
 * @param suffix — optional extra suffix (e.g. session ID) instead of PID.
 */
export function natsConnectOptions(name: string, suffix?: string): NatsConnectOptions {
  const user = process.env.NATS_USER || undefined;
  const pass = process.env.NATS_PASS || undefined;

  return {
    servers: process.env.NATS_URL ?? 'nats://localhost:4222',
    name: `ax-${name}-${suffix ?? process.pid}`,
    ...(user ? { user } : {}),
    ...(pass ? { pass } : {}),
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  };
}
