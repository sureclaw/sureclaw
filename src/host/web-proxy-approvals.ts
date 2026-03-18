/**
 * Pending approval registry for the web proxy governance gate.
 *
 * When the proxy encounters a new domain, it calls requestApproval() which
 * blocks until the domain is approved/denied via resolveApproval() (called
 * from the web_proxy_approve IPC handler) or times out.
 *
 * Keyed by sessionId + domain. Each domain is asked at most once per session.
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'web-proxy-approvals' });

/** How long to wait for user approval before auto-denying. */
const APPROVAL_TIMEOUT_MS = 120_000;

interface PendingEntry {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** sessionId → Map<domain, PendingEntry> */
const pending = new Map<string, Map<string, PendingEntry>>();

/** sessionId → Set<approved domain> */
const approvedCache = new Map<string, Set<string>>();

/** sessionId → Set<denied domain> */
const deniedCache = new Map<string, Set<string>>();

/**
 * Check if a domain has already been approved for this session.
 */
export function isDomainApproved(sessionId: string, domain: string): boolean {
  return approvedCache.get(sessionId)?.has(domain) ?? false;
}

/**
 * Check if a domain has already been denied for this session.
 */
export function isDomainDenied(sessionId: string, domain: string): boolean {
  return deniedCache.get(sessionId)?.has(domain) ?? false;
}

/**
 * Request approval for a domain. Returns a Promise that resolves when
 * the user approves/denies or the timeout expires.
 */
export function requestApproval(sessionId: string, domain: string): Promise<boolean> {
  // Already decided
  if (isDomainApproved(sessionId, domain)) return Promise.resolve(true);
  if (isDomainDenied(sessionId, domain)) return Promise.resolve(false);

  // Already pending — piggyback on the existing request
  const sessionPending = pending.get(sessionId);
  if (sessionPending?.has(domain)) {
    return new Promise<boolean>((resolve) => {
      const existing = sessionPending.get(domain)!;
      const origResolve = existing.resolve;
      existing.resolve = (approved) => {
        origResolve(approved);
        resolve(approved);
      };
    });
  }

  return new Promise<boolean>((resolve) => {
    let map = pending.get(sessionId);
    if (!map) {
      map = new Map();
      pending.set(sessionId, map);
    }

    const timer = setTimeout(() => {
      map!.delete(domain);
      if (map!.size === 0) pending.delete(sessionId);

      // Cache the denial
      let denied = deniedCache.get(sessionId);
      if (!denied) { denied = new Set(); deniedCache.set(sessionId, denied); }
      denied.add(domain);

      logger.info('approval_timeout', { sessionId, domain });
      resolve(false);
    }, APPROVAL_TIMEOUT_MS);
    // Don't prevent process exit
    if (timer.unref) timer.unref();

    map.set(domain, { resolve, timer });
    logger.debug('approval_requested', { sessionId, domain });
  });
}

/**
 * Resolve a pending approval. Called from the web_proxy_approve IPC handler.
 * Returns true if a pending request was found and resolved.
 */
export function resolveApproval(sessionId: string, domain: string, approved: boolean): boolean {
  const sessionPending = pending.get(sessionId);
  const entry = sessionPending?.get(domain);
  if (!entry) return false;

  clearTimeout(entry.timer);
  sessionPending!.delete(domain);
  if (sessionPending!.size === 0) pending.delete(sessionId);

  // Cache the decision
  if (approved) {
    let set = approvedCache.get(sessionId);
    if (!set) { set = new Set(); approvedCache.set(sessionId, set); }
    set.add(domain);
  } else {
    let set = deniedCache.get(sessionId);
    if (!set) { set = new Set(); deniedCache.set(sessionId, set); }
    set.add(domain);
  }

  logger.info('approval_resolved', { sessionId, domain, approved });
  entry.resolve(approved);
  return true;
}

/**
 * Pre-approve a domain so future proxy requests skip the onApprove callback.
 * Called from the web_proxy_approve IPC handler when the agent grants access
 * before running a command that needs it (e.g. npm install).
 */
export function preApproveDomain(sessionId: string, domain: string): void {
  let set = approvedCache.get(sessionId);
  if (!set) { set = new Set(); approvedCache.set(sessionId, set); }
  set.add(domain);
  // Clear any stale denial
  deniedCache.get(sessionId)?.delete(domain);
  logger.debug('domain_preapproved', { sessionId, domain });
}

/**
 * Clean up all approval state for a session. Call when the session ends.
 */
export function cleanupSession(sessionId: string): void {
  const sessionPending = pending.get(sessionId);
  if (sessionPending) {
    for (const entry of sessionPending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    pending.delete(sessionId);
  }
  approvedCache.delete(sessionId);
  deniedCache.delete(sessionId);
}
