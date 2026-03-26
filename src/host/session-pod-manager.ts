/**
 * Session Pod Manager — Tracks session-long pods.
 *
 * Maps sessionId → active pod. Pods are reused across turns.
 * Work payloads are queued per-token; pods fetch via GET /internal/work.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-pod-manager' });

export interface SessionPod {
  podName: string;
  pid: number;
  sessionId: string;
  /** The original IPC token the pod was spawned with — used to authenticate work fetch. */
  authToken: string;
  /** Last IPC activity timestamp (ms). Reset on every IPC call. */
  lastActivity: number;
  /** Whether the sandbox has made filesystem changes (write/edit/bash). */
  dirty: boolean;
  /** Timer for the expiry warning (fires 120s before kill). */
  warningTimer?: ReturnType<typeof setTimeout>;
  /** Timer for the final kill (fires after warning period). */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Per-turn token for the current active turn. Null between turns. */
  activeTurnToken: string | null;
  /** Kill function from SandboxProcess. */
  kill: () => void;
}

export interface PendingWork {
  payload: string;
  resolve: (value: string) => void;
  reject: (err: Error) => void;
}

export interface SessionPodManagerOptions {
  idleTimeoutMs: number;       // e.g. 30 * 60 * 1000 (30 min)
  cleanIdleTimeoutMs?: number; // e.g. 5 * 60 * 1000 (5 min) — used when no FS changes
  warningLeadMs: number;       // e.g. 120 * 1000 (120s before kill)
  onExpiring?: (sessionId: string, pod: SessionPod) => Promise<void>;
  onKill?: (sessionId: string, pod: SessionPod) => void;
}

export function createSessionPodManager(opts: SessionPodManagerOptions) {
  const sessions = new Map<string, SessionPod>();
  const tokenToSession = new Map<string, string>();     // authToken → sessionId
  const pendingWork = new Map<string, PendingWork>();   // sessionId → pending work

  const cleanTimeout = opts.cleanIdleTimeoutMs ?? opts.idleTimeoutMs;

  /** Shared teardown: clears timers, rejects pending work, revokes auth token, removes session. */
  function teardown(sessionId: string): void {
    const pod = sessions.get(sessionId);
    if (!pod) return;
    if (pod.warningTimer) clearTimeout(pod.warningTimer);
    if (pod.killTimer) clearTimeout(pod.killTimer);
    // Reject any queued work so callers don't hang
    const work = pendingWork.get(sessionId);
    if (work) {
      work.reject(new Error(`Session ${sessionId} torn down`));
      pendingWork.delete(sessionId);
    }
    tokenToSession.delete(pod.authToken);
    sessions.delete(sessionId);
  }

  function resetIdleTimer(sessionId: string): void {
    const pod = sessions.get(sessionId);
    if (!pod) return;

    pod.lastActivity = Date.now();

    // Clear existing timers
    if (pod.warningTimer) clearTimeout(pod.warningTimer);
    if (pod.killTimer) clearTimeout(pod.killTimer);

    // Shorter timeout for clean (no FS changes) sessions — nothing to preserve
    const effectiveTimeout = pod.dirty ? opts.idleTimeoutMs : cleanTimeout;

    // Set warning timer (fires warningLeadMs before the kill)
    const warningDelay = effectiveTimeout - opts.warningLeadMs;
    pod.warningTimer = setTimeout(async () => {
      logger.info('session_expiring_warning', { sessionId, podName: pod.podName });
      try {
        await opts.onExpiring?.(sessionId, pod);
      } catch (err) {
        logger.warn('session_expiring_callback_failed', { sessionId, error: (err as Error).message });
      }

      // Set kill timer for after the warning period
      pod.killTimer = setTimeout(() => {
        logger.info('session_pod_idle_kill', { sessionId, podName: pod.podName, dirty: pod.dirty });
        pod.kill();
        teardown(sessionId);
        opts.onKill?.(sessionId, pod);
      }, opts.warningLeadMs);
      if (pod.killTimer.unref) pod.killTimer.unref();
    }, Math.max(warningDelay, 0));
    if (pod.warningTimer.unref) pod.warningTimer.unref();
  }

  return {
    /** Register a pod for a session. */
    register(sessionId: string, pod: Omit<SessionPod, 'lastActivity' | 'activeTurnToken' | 'dirty'>): void {
      const entry: SessionPod = { ...pod, lastActivity: Date.now(), activeTurnToken: null, dirty: false };
      sessions.set(sessionId, entry);
      tokenToSession.set(pod.authToken, sessionId);
      resetIdleTimer(sessionId);
      logger.info('session_pod_registered', { sessionId, podName: pod.podName });
    },

    /** Get the active pod for a session, or undefined. */
    get(sessionId: string): SessionPod | undefined {
      return sessions.get(sessionId);
    },

    /** Check if session has an active pod. */
    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    /** Remove a session (pod exited or was killed externally). */
    remove(sessionId: string): void {
      teardown(sessionId);
    },

    /** Record IPC activity — resets the idle timer. */
    touch(sessionId: string): void {
      resetIdleTimer(sessionId);
    },

    /** Mark session as dirty (FS changes made). Switches to the longer idle timeout. */
    markDirty(sessionId: string): void {
      const pod = sessions.get(sessionId);
      if (!pod || pod.dirty) return;
      pod.dirty = true;
      logger.info('session_marked_dirty', { sessionId, podName: pod.podName });
      // Reset timer so the longer timeout takes effect immediately
      resetIdleTimer(sessionId);
    },

    /** Queue a work payload for a session's pod to fetch via GET /internal/work. */
    queueWork(sessionId: string, payload: string): Promise<string> {
      return new Promise((resolve, reject) => {
        pendingWork.set(sessionId, { payload, resolve, reject });
      });
    },

    /** Pod calls this to fetch its work by session ID. Returns the payload and removes from queue. */
    claimWork(sessionId: string): PendingWork | undefined {
      const work = pendingWork.get(sessionId);
      if (work) pendingWork.delete(sessionId);
      return work;
    },

    /** Look up session ID from a pod's auth token (used by GET /internal/work). */
    findSessionByToken(token: string): string | undefined {
      return tokenToSession.get(token);
    },

    /** Get all active sessions (for metrics/debugging). */
    activeSessions(): string[] {
      return [...sessions.keys()];
    },

    /** Shutdown — kill all pods, clear timers. */
    shutdown(): void {
      for (const [, pod] of sessions) {
        if (pod.warningTimer) clearTimeout(pod.warningTimer);
        if (pod.killTimer) clearTimeout(pod.killTimer);
        pod.kill();
      }
      sessions.clear();
      tokenToSession.clear();
      for (const [, work] of pendingWork) {
        work.reject(new Error('Session pod manager shutting down'));
      }
      pendingWork.clear();
    },
  };
}
