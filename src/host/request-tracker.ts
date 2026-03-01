/**
 * Request Tracker — queryable request lifecycle state.
 *
 * Tracks completion requests through their lifecycle:
 * queued → processing → done | error | cancelled
 *
 * Auto-cleans completed entries after a configurable TTL to prevent
 * unbounded memory growth.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'request-tracker' });

export type RequestState = 'queued' | 'processing' | 'done' | 'error' | 'cancelled';

export interface TrackedRequest {
  requestId: string;
  state: RequestState;
  createdAt: number;
  updatedAt: number;
  /** Queue position at time of enqueue (0 = started immediately). */
  queuePosition?: number;
  /** Error message if state is 'error'. */
  error?: string;
  /** Session ID associated with this request. */
  sessionId?: string;
}

export interface RequestStats {
  queued: number;
  processing: number;
  done: number;
  error: number;
  cancelled: number;
  total: number;
}

export interface RequestTracker {
  /** Start tracking a new request. */
  track(requestId: string, opts?: { queuePosition?: number; sessionId?: string }): void;
  /** Transition to processing state. */
  processing(requestId: string): void;
  /** Mark as done. */
  done(requestId: string): void;
  /** Mark as error. */
  fail(requestId: string, error: string): void;
  /** Mark as cancelled. */
  cancel(requestId: string): void;
  /** Get a tracked request by ID. */
  get(requestId: string): TrackedRequest | undefined;
  /** Get summary stats. */
  stats(): RequestStats;
  /** Stop the cleanup timer. */
  dispose(): void;
}

/** How long to keep completed/error/cancelled entries before cleanup (ms). */
const DEFAULT_COMPLETED_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** How often to run the cleanup sweep (ms). */
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000; // 1 minute

export function createRequestTracker(opts?: {
  completedTtlMs?: number;
  cleanupIntervalMs?: number;
}): RequestTracker {
  const completedTtlMs = opts?.completedTtlMs ?? DEFAULT_COMPLETED_TTL_MS;
  const cleanupIntervalMs = opts?.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;

  const requests = new Map<string, TrackedRequest>();

  // Periodic cleanup of old completed entries
  const cleanupInterval = setInterval(() => {
    const cutoff = Date.now() - completedTtlMs;
    const terminalStates: RequestState[] = ['done', 'error', 'cancelled'];
    for (const [id, req] of requests) {
      if (terminalStates.includes(req.state) && req.updatedAt < cutoff) {
        requests.delete(id);
      }
    }
  }, cleanupIntervalMs);

  // Don't block process exit
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  function track(requestId: string, trackOpts?: { queuePosition?: number; sessionId?: string }): void {
    const now = Date.now();
    requests.set(requestId, {
      requestId,
      state: 'queued',
      createdAt: now,
      updatedAt: now,
      queuePosition: trackOpts?.queuePosition,
      sessionId: trackOpts?.sessionId,
    });
    logger.debug('request_tracked', { requestId, queuePosition: trackOpts?.queuePosition });
  }

  function transition(requestId: string, state: RequestState, extra?: Partial<TrackedRequest>): void {
    const req = requests.get(requestId);
    if (!req) {
      logger.debug('request_not_found', { requestId, targetState: state });
      return;
    }
    req.state = state;
    req.updatedAt = Date.now();
    if (extra) Object.assign(req, extra);
    logger.debug('request_transition', { requestId, state });
  }

  return {
    track,
    processing: (id) => transition(id, 'processing'),
    done: (id) => transition(id, 'done'),
    fail: (id, error) => transition(id, 'error', { error }),
    cancel: (id) => transition(id, 'cancelled'),
    get: (id) => requests.get(id),
    stats: () => {
      const s: RequestStats = { queued: 0, processing: 0, done: 0, error: 0, cancelled: 0, total: 0 };
      for (const req of requests.values()) {
        s[req.state]++;
        s.total++;
      }
      return s;
    },
    dispose: () => clearInterval(cleanupInterval),
  };
}
