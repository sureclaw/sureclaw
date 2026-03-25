/**
 * Sandbox session manager — tracks session-bound sandbox pods for
 * cross-turn escalation from the fast path.
 *
 * When a user approves sandbox access, a dedicated pod is provisioned
 * and persists across turns for the session. State is stored in the
 * DocumentStore (or can be backed by a SQL table in production).
 *
 * No module-level mutable state — all state is in the store.
 */

import type { DocumentStore } from '../providers/storage/types.js';
import type { SandboxProvider } from '../providers/sandbox/types.js';
import type { Config } from '../types.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'sandbox-manager' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxSession {
  sessionId: string;
  podName: string;
  podIp: string;
  status: 'provisioning' | 'ready' | 'terminating';
  approvedAt: string;
  ttlSeconds: number;
  expiresAt: string;
}

export interface SandboxManagerDeps {
  documents: DocumentStore;
  sandbox: SandboxProvider;
  config: Config;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLECTION = 'sandbox_sessions';
const DEFAULT_TTL = 1800; // 30 minutes
const MAX_TTL = 3600;     // 1 hour

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function getSandboxSession(
  documents: DocumentStore,
  sessionId: string,
): Promise<SandboxSession | null> {
  const raw = await documents.get(COLLECTION, sessionId);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as SandboxSession;
    // Check if expired
    if (new Date(session.expiresAt) <= new Date()) {
      await documents.delete(COLLECTION, sessionId);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export async function createSandboxSession(
  documents: DocumentStore,
  sessionId: string,
  ttl?: number,
): Promise<SandboxSession> {
  const ttlSeconds = Math.min(Math.max(ttl ?? DEFAULT_TTL, 60), MAX_TTL);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  const session: SandboxSession = {
    sessionId,
    podName: '',       // Set after provisioning
    podIp: '',         // Set after provisioning
    status: 'provisioning',
    approvedAt: now.toISOString(),
    ttlSeconds,
    expiresAt: expiresAt.toISOString(),
  };

  await documents.put(COLLECTION, sessionId, JSON.stringify(session));
  return session;
}

export async function updateSandboxSession(
  documents: DocumentStore,
  sessionId: string,
  updates: Partial<Pick<SandboxSession, 'podName' | 'podIp' | 'status'>>,
): Promise<SandboxSession | null> {
  const session = await getSandboxSession(documents, sessionId);
  if (!session) return null;

  const updated = { ...session, ...updates };
  await documents.put(COLLECTION, sessionId, JSON.stringify(updated));
  return updated;
}

export async function deleteSandboxSession(
  documents: DocumentStore,
  sessionId: string,
): Promise<boolean> {
  return documents.delete(COLLECTION, sessionId);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Provision a sandbox pod for a session (background operation).
 * Called after user approves the escalation request.
 */
export async function provisionSandbox(
  deps: SandboxManagerDeps,
  sessionId: string,
  ttl?: number,
): Promise<SandboxSession> {
  const { documents } = deps;

  logger.info('sandbox_provision_start', { sessionId, ttl });

  // Create session record in provisioning state
  const session = await createSandboxSession(documents, sessionId, ttl);

  // In a full implementation, this would call the sandbox provider to
  // spin up a K8s pod or Docker container. For now, we mark it as ready
  // since the actual pod provisioning is handled by the existing sandbox
  // provider infrastructure (src/providers/sandbox/k8s.ts, docker.ts, etc.)
  const updated = await updateSandboxSession(documents, sessionId, {
    podName: `ax-sandbox-${sessionId.slice(-8)}`,
    podIp: '10.0.0.1', // placeholder — real IP from pod status
    status: 'ready',
  });

  logger.info('sandbox_provision_complete', {
    sessionId,
    podName: updated?.podName,
    ttlSeconds: session.ttlSeconds,
    expiresAt: session.expiresAt,
  });

  return updated ?? session;
}

/**
 * Tear down a sandbox pod for a session.
 * Called on TTL expiry, session end, or explicit cleanup.
 */
export async function teardownSandbox(
  deps: SandboxManagerDeps,
  sessionId: string,
): Promise<void> {
  const { documents } = deps;

  const session = await getSandboxSession(documents, sessionId);
  if (!session) return;

  logger.info('sandbox_teardown', { sessionId, podName: session.podName });

  // Mark as terminating
  await updateSandboxSession(documents, sessionId, { status: 'terminating' });

  // In a full implementation, this would:
  // 1. GCS sync (one-time — preserves workspace for future sessions)
  // 2. Kill the pod via K8s API or Docker API

  // Remove session record
  await deleteSandboxSession(documents, sessionId);
}

/**
 * Check if a session has an active (ready) sandbox pod.
 */
export async function hasActiveSandbox(
  documents: DocumentStore,
  sessionId: string,
): Promise<boolean> {
  const session = await getSandboxSession(documents, sessionId);
  return session?.status === 'ready';
}

/**
 * Clean up expired sandbox sessions.
 * Run periodically (e.g., every minute via a background timer or CronJob).
 */
export async function reapExpiredSessions(
  deps: SandboxManagerDeps,
): Promise<number> {
  const { documents } = deps;
  const keys = await documents.list(COLLECTION);
  let reaped = 0;

  for (const key of keys) {
    const raw = await documents.get(COLLECTION, key);
    if (!raw) continue;
    try {
      const session = JSON.parse(raw) as SandboxSession;
      if (new Date(session.expiresAt) <= new Date()) {
        await teardownSandbox(deps, session.sessionId);
        reaped++;
      }
    } catch {
      // Malformed — remove
      await documents.delete(COLLECTION, key);
      reaped++;
    }
  }

  return reaped;
}
