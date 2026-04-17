// src/host/credential-request-queue.ts
//
// In-memory queue of pending ad-hoc credential requests emitted by the
// `request_credential` agent tool. One entry per (sessionId, envName).
// Enqueueing the same pair twice is a no-op (overwrite in place).
//
// Why a queue at all? The event bus emits `credential.required` events that
// the SSE stream forwards to connected clients — but a client that connects
// AFTER the event fires never sees it. The dashboard needs to display any
// pending credential request when it loads, so we persist them in memory
// here and expose them via `GET /admin/api/credentials/requests`.
//
// Memory-only on purpose. If the host restarts, pending requests are
// dropped; the agent will re-request on its next attempt. Simpler than
// persisting to the database, and request_credential is already idempotent
// upstream.

export interface CredentialRequest {
  sessionId: string;
  envName: string;
  agentName: string;
  userId?: string;
  createdAt: number;
}

export interface CredentialRequestQueue {
  enqueue(req: CredentialRequest): void;
  /** Drop matching entries (same sessionId + envName). Returns number removed. */
  dequeue(sessionId: string, envName: string): number;
  /** Snapshot of pending requests. Entries are deep-copied; safe to mutate externally. */
  snapshot(): CredentialRequest[];
}

function keyFor(sessionId: string, envName: string): string {
  return `${sessionId}:${envName}`;
}

export function createCredentialRequestQueue(): CredentialRequestQueue {
  const map = new Map<string, CredentialRequest>();

  return {
    enqueue(req) {
      map.set(keyFor(req.sessionId, req.envName), { ...req });
    },
    dequeue(sessionId, envName) {
      const key = keyFor(sessionId, envName);
      return map.delete(key) ? 1 : 0;
    },
    snapshot() {
      return [...map.values()].map((r) => ({ ...r }));
    },
  };
}
