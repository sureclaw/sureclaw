/**
 * Web proxy approval coordination via event bus.
 *
 * requestApproval() subscribes to the event bus for proxy.approval events
 * and returns a Promise that resolves when the domain is approved/denied
 * or times out. Works across stateless host replicas: in-process event bus
 * for local/Docker, NATS-backed event bus for k8s.
 *
 * Replaces the old in-memory promise map pattern that required session affinity.
 *
 * Caches (approved/denied) remain in-memory since they're only used to
 * short-circuit repeated lookups within the same request lifetime.
 */

import type { EventBus } from './event-bus.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'web-proxy-approvals' });

/** How long to wait for user approval before auto-denying. */
const APPROVAL_TIMEOUT_MS = 120_000;

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
 * Wait for a domain approval to be provided via the event bus.
 *
 * Subscribes to events for the given requestId and resolves when a
 * proxy.approval event with matching domain arrives. Returns true if
 * approved, false if denied or timed out.
 */
export function requestApproval(
  sessionId: string,
  domain: string,
  eventBus: EventBus,
  requestId: string,
  timeoutMs = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  // Already decided — short-circuit from cache
  if (isDomainApproved(sessionId, domain)) return Promise.resolve(true);
  if (isDomainDenied(sessionId, domain)) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let settled = false;

    const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
      if (settled) return;
      if (event.type !== 'proxy.approval') return;
      if (event.data?.domain !== domain) return;

      settled = true;
      clearTimeout(timer);
      unsubscribe();

      const approved = event.data.approved === true;

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

      logger.info('approval_resolved_via_event', { sessionId, domain, approved, requestId });
      resolve(approved);
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      unsubscribe();

      // Cache the denial
      let denied = deniedCache.get(sessionId);
      if (!denied) { denied = new Set(); deniedCache.set(sessionId, denied); }
      denied.add(domain);

      logger.info('approval_timeout', { sessionId, domain, requestId });
      resolve(false);
    }, timeoutMs);

    // Don't prevent process exit
    if (timer.unref) timer.unref();

    logger.debug('approval_requested', { sessionId, domain, requestId });
  });
}

/**
 * Resolve a pending approval via the event bus.
 * Publishes a proxy.approval event so any replica waiting on requestApproval() receives it.
 */
export function resolveApproval(
  sessionId: string,
  domain: string,
  approved: boolean,
  eventBus: EventBus,
  requestId: string,
): void {
  // Cache locally too (for same-replica short-circuit on subsequent requests)
  if (approved) {
    let set = approvedCache.get(sessionId);
    if (!set) { set = new Set(); approvedCache.set(sessionId, set); }
    set.add(domain);
  } else {
    let set = deniedCache.get(sessionId);
    if (!set) { set = new Set(); deniedCache.set(sessionId, set); }
    set.add(domain);
  }

  eventBus.emit({
    type: 'proxy.approval',
    requestId,
    timestamp: Date.now(),
    data: { domain, approved, sessionId },
  });

  logger.info('approval_resolved', { sessionId, domain, approved, requestId });
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
  approvedCache.delete(sessionId);
  deniedCache.delete(sessionId);
}
