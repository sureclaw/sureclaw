// src/host/nats-session-protocol.ts — NATS protocol helpers.
//
// Lightweight encode/decode + subject builders used by host-process.ts
// for EventBus SSE streaming over NATS.

// ── NATS subjects ──

/** Event subjects: events.{requestId} */
export function eventSubject(requestId: string): string {
  return `events.${requestId}`;
}

// ── Serialization ──

export function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function decode<T = unknown>(data: Uint8Array): T {
  return JSON.parse(new TextDecoder().decode(data)) as T;
}
