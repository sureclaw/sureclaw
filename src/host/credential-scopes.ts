// src/host/credential-scopes.ts
//
// Scoped credential resolution. Credentials are never global — they belong
// to an agent (shared across users) or a specific user of that agent.
//
// Lookup order: user:<agentName>:<userId> → agent:<agentName>

import type { CredentialProvider } from '../providers/credentials/types.js';

/** Build a credential scope key. */
export function credentialScope(agentName: string, userId?: string): string {
  if (userId) return `user:${agentName}:${userId}`;
  return `agent:${agentName}`;
}

/**
 * Resolve a credential by trying user scope first, then agent scope.
 * Returns null if not found in either scope.
 */
// ── Session credential context ──
// Maps sessionId → { agentName, userId } so the /v1/credentials/provide
// endpoint can resolve the correct scope without the client having to send
// agentName/userId.  Populated when credential.required events are emitted.

export interface CredentialSessionContext {
  agentName: string;
  userId?: string;
}

const sessionContexts = new Map<string, CredentialSessionContext>();

export function setSessionCredentialContext(sessionId: string, ctx: CredentialSessionContext): void {
  sessionContexts.set(sessionId, ctx);
}

export function getSessionCredentialContext(sessionId: string): CredentialSessionContext | undefined {
  return sessionContexts.get(sessionId);
}

export function clearSessionCredentialContext(sessionId: string): void {
  sessionContexts.delete(sessionId);
}

/**
 * Resolve a credential by trying user scope first, then agent scope.
 * Returns null if not found in either scope.
 */
export async function resolveCredential(
  provider: CredentialProvider,
  envName: string,
  agentName: string,
  userId?: string,
): Promise<string | null> {
  // Try user scope first
  if (userId) {
    const userVal = await provider.get(envName, credentialScope(agentName, userId));
    if (userVal !== null) return userVal;
  }

  // Fall back to agent scope
  const agentVal = await provider.get(envName, credentialScope(agentName));
  if (agentVal !== null) return agentVal;

  return null;
}
