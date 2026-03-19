/**
 * Pending credential prompt registry.
 *
 * When the host detects a missing credential during sandbox launch, it calls
 * requestCredential() which blocks until the user provides the value via
 * resolveCredential() (called from the HTTP endpoint or IPC handler) or
 * the timeout expires (returns null).
 *
 * Modeled on web-proxy-approvals.ts.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'credential-prompts' });

/** How long to wait for the user to provide a credential before giving up. */
const DEFAULT_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolvers: Array<(value: string | null) => void>;
  timer: ReturnType<typeof setTimeout>;
}

/** sessionId → Map<envName, PendingEntry> */
const pending = new Map<string, Map<string, PendingEntry>>();

/**
 * Request a credential from the user. Returns a Promise that resolves with
 * the credential value when provided, or null if the timeout expires.
 */
export function requestCredential(
  sessionId: string,
  envName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string | null> {
  // Already pending — piggyback on the existing request
  const sessionPending = pending.get(sessionId);
  if (sessionPending?.has(envName)) {
    return new Promise<string | null>((resolve) => {
      const existing = sessionPending.get(envName)!;
      existing.resolvers.push(resolve);
    });
  }

  return new Promise<string | null>((resolve) => {
    let map = pending.get(sessionId);
    if (!map) {
      map = new Map();
      pending.set(sessionId, map);
    }

    const entry: PendingEntry = {
      resolvers: [resolve],
      timer: setTimeout(() => {
        map!.delete(envName);
        if (map!.size === 0) pending.delete(sessionId);
        logger.info('credential_prompt_timeout', { sessionId, envName });
        entry.resolvers.forEach(r => r(null));
      }, timeoutMs),
    };
    if (entry.timer.unref) entry.timer.unref();

    map.set(envName, entry);
    logger.debug('credential_prompt_requested', { sessionId, envName });
  });
}

/**
 * Resolve a pending credential prompt. Called from the HTTP endpoint or IPC handler.
 * Returns true if a pending request was found and resolved.
 */
export function resolveCredential(sessionId: string, envName: string, value: string): boolean {
  const sessionPending = pending.get(sessionId);
  const entry = sessionPending?.get(envName);
  if (!entry) return false;

  clearTimeout(entry.timer);
  sessionPending!.delete(envName);
  if (sessionPending!.size === 0) pending.delete(sessionId);

  logger.info('credential_prompt_resolved', { sessionId, envName });
  entry.resolvers.forEach(r => r(value));
  return true;
}

/**
 * Clean up all pending prompts for a session.
 */
export function cleanupSession(sessionId: string): void {
  const sessionPending = pending.get(sessionId);
  if (sessionPending) {
    for (const entry of sessionPending.values()) {
      clearTimeout(entry.timer);
      entry.resolvers.forEach(r => r(null));
    }
    pending.delete(sessionId);
  }
}
