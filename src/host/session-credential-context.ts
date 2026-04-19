// src/host/session-credential-context.ts
//
// Session credential context. Maps sessionId → { agentName, userId } so the
// /v1/credentials/provide endpoint can resolve the correct caller without
// the client having to send agentName/userId. Populated when
// credential.required events are emitted.

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
