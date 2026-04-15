/**
 * Session Manager — Tracks session-long sandboxes across turns.
 *
 * Unified replacement for SessionPodManager. Works with both Docker containers
 * (via Unix socket IPC) and k8s pods (via HTTP IPC). Maps sessionId → active
 * sandbox process. Sandbox processes are reused across turns within a session.
 *
 * Work payloads are queued per-session; agents fetch via fetch_work IPC action
 * or GET /internal/work (k8s HTTP fallback).
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-manager' });

export interface SessionEntry {
  pid: number;
  /** Pod name (k8s) or container name (Docker). Optional. */
  podName?: string;
  sessionId: string;
  /** Auth token for HTTP IPC authentication (k8s only). */
  authToken?: string;
  /** Reusable workspace directory path (persists across turns). */
  workspace?: string;
  /** Reusable git metadata directory (persists across turns). */
  gitDir?: string;
  /** Last activity timestamp (ms). Reset on every touch(). */
  lastActivity: number;
  /** Whether the sandbox has made filesystem changes. */
  dirty: boolean;
  /** Timer for the expiry warning. */
  warningTimer?: ReturnType<typeof setTimeout>;
  /** Timer for the final kill. */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Kill function from SandboxProcess. */
  kill: () => void;
}

export interface SessionManagerOptions {
  idleTimeoutMs: number;
  cleanIdleTimeoutMs?: number;
  warningLeadMs: number;
  onExpiring?: (sessionId: string, entry: SessionEntry) => Promise<void>;
  onKill?: (sessionId: string, entry: SessionEntry) => void;
}

export type SessionManager = ReturnType<typeof createSessionManager>;

export function createSessionManager(opts: SessionManagerOptions) {
  const sessions = new Map<string, SessionEntry>();
  const tokenToSession = new Map<string, string>();
  const pendingWork = new Map<string, string>(); // sessionId → payload

  const cleanTimeout = opts.cleanIdleTimeoutMs ?? opts.idleTimeoutMs;

  function teardown(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.warningTimer) clearTimeout(entry.warningTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    pendingWork.delete(sessionId);
    if (entry.authToken) tokenToSession.delete(entry.authToken);
    sessions.delete(sessionId);
  }

  function resetIdleTimer(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    entry.lastActivity = Date.now();
    if (entry.warningTimer) clearTimeout(entry.warningTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);

    const effectiveTimeout = entry.dirty ? opts.idleTimeoutMs : cleanTimeout;
    // Clamp warning lead to the effective timeout so the total never exceeds it
    const leadMs = Math.min(opts.warningLeadMs, effectiveTimeout);
    const warningDelay = Math.max(effectiveTimeout - leadMs, 0);

    entry.warningTimer = setTimeout(async () => {
      logger.info('session_expiring_warning', { sessionId, podName: entry.podName });
      try {
        await opts.onExpiring?.(sessionId, entry);
      } catch (err) {
        logger.warn('session_expiring_callback_failed', { sessionId, error: (err as Error).message });
      }
      entry.killTimer = setTimeout(() => {
        logger.info('session_idle_kill', { sessionId, podName: entry.podName, dirty: entry.dirty });
        entry.kill();
        teardown(sessionId);
        opts.onKill?.(sessionId, entry);
      }, leadMs);
      if (entry.killTimer.unref) entry.killTimer.unref();
    }, warningDelay);
    if (entry.warningTimer.unref) entry.warningTimer.unref();
  }

  return {
    /** Register a sandbox for a session. */
    register(sessionId: string, info: { pid: number; kill: () => void; podName?: string; authToken?: string; workspace?: string; gitDir?: string }): void {
      const entry: SessionEntry = {
        ...info,
        sessionId,
        lastActivity: Date.now(),
        dirty: false,
      };
      sessions.set(sessionId, entry);
      if (info.authToken) tokenToSession.set(info.authToken, sessionId);
      resetIdleTimer(sessionId);
      logger.info('session_registered', { sessionId, podName: info.podName, pid: info.pid });
    },

    /** Get the active sandbox for a session, or undefined. */
    get(sessionId: string): SessionEntry | undefined {
      return sessions.get(sessionId);
    },

    /** Check if session has an active sandbox. */
    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    /** Remove a session (sandbox exited or was killed externally). */
    remove(sessionId: string): void {
      teardown(sessionId);
    },

    /** Record activity — resets the idle timer. */
    touch(sessionId: string): void {
      resetIdleTimer(sessionId);
    },

    /** Mark session as dirty (FS changes made). Switches to longer idle timeout. */
    markDirty(sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (!entry || entry.dirty) return;
      entry.dirty = true;
      logger.info('session_marked_dirty', { sessionId, podName: entry.podName });
      resetIdleTimer(sessionId);
    },

    /** Queue a work payload for an agent to fetch via fetch_work IPC action. */
    queueWork(sessionId: string, payload: string): void {
      pendingWork.set(sessionId, payload);
    },

    /** Claim queued work for a session. Returns payload and removes from queue. */
    claimWork(sessionId: string): string | undefined {
      const payload = pendingWork.get(sessionId);
      if (payload !== undefined) pendingWork.delete(sessionId);
      return payload;
    },

    /** Look up session ID from an auth token (used by HTTP IPC routes). */
    findSessionByToken(token: string): string | undefined {
      return tokenToSession.get(token);
    },

    /** Get all active session IDs (for metrics/debugging). */
    activeSessions(): string[] {
      return [...sessions.keys()];
    },

    /** Shutdown — kill all sandboxes, clear timers. */
    shutdown(): void {
      for (const [, entry] of sessions) {
        if (entry.warningTimer) clearTimeout(entry.warningTimer);
        if (entry.killTimer) clearTimeout(entry.killTimer);
        entry.kill();
      }
      sessions.clear();
      tokenToSession.clear();
      pendingWork.clear();
    },
  };
}
