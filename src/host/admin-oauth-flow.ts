// src/host/admin-oauth-flow.ts — In-memory pending-flow map for
// admin-initiated OAuth. Parallel to oauth-skills.ts's pendingFlows: the
// admin flow has its own schema (skillName / envName / scope / agentId +
// admin-override clientSecret) and is triggered by the dashboard, not by
// an agent.
//
// Contract:
//   - 15-minute TTL per entry.
//   - `claim(state)` is single-use: it returns the stored flow and removes
//     it from the map. A second claim for the same state returns undefined
//     (callback replay defense).
//   - Sweep expired entries on every start/claim/size call so the map
//     doesn't grow unbounded across a long-lived process.

import { generateCodeVerifier, generateCodeChallenge, generateState } from './oauth.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'admin-oauth-flow' });

const TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface AdminOAuthPendingFlow {
  agentId: string;
  agentName: string; // credential-scope source
  skillName: string;
  envName: string;
  scope: 'user' | 'agent';
  userId?: string; // already-resolved (body.userId ?? defaultUserId ?? 'admin')
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string; // effective client_id (admin > frontmatter)
  clientSecret?: string; // populated only for admin-registered providers
  provider: string; // frontmatter oauth.provider
  scopes: string[];
  createdAt: number;
}

export interface StartFlowInput {
  agentId: string;
  agentName: string;
  skillName: string;
  envName: string;
  scope: 'user' | 'agent';
  userId?: string;
  provider: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string; // frontmatter clientId (may be overridden)
  scopes: string[];
  redirectUri: string;
  /** When present, admin clientId wins over frontmatter's; clientSecret is
   *  stored only when admin-registered supplies one. */
  adminOverride?: { clientId: string; clientSecret?: string };
}

export interface AdminOAuthFlow {
  /** Generate PKCE params + state, store the pending flow, return { state, authUrl }. */
  start(input: StartFlowInput): { state: string; authUrl: string };

  /** Look up and REMOVE a pending flow. Returns undefined when the state is
   *  unknown or the entry has exceeded its TTL. Single-use by design —
   *  a callback replay attempt with the same state yields undefined. */
  claim(state: string): AdminOAuthPendingFlow | undefined;

  /** For tests. Number of live (non-expired) flows. */
  size(): number;
}

export interface CreateAdminOAuthFlowOpts {
  /** For tests. Override the clock. */
  now?: () => number;
}

export function createAdminOAuthFlow(opts: CreateAdminOAuthFlowOpts = {}): AdminOAuthFlow {
  const now = opts.now ?? (() => Date.now());
  const flows = new Map<string, AdminOAuthPendingFlow>();

  function sweepExpired(): void {
    const cutoff = now() - TTL_MS;
    for (const [state, flow] of flows) {
      if (flow.createdAt < cutoff) flows.delete(state);
    }
  }

  return {
    start(input) {
      sweepExpired();
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = generateCodeChallenge(codeVerifier);
      const state = generateState();

      // Admin override wins for clientId; clientSecret only set when admin-registered.
      const effectiveClientId = input.adminOverride?.clientId ?? input.clientId;
      const effectiveSecret = input.adminOverride?.clientSecret;

      flows.set(state, {
        agentId: input.agentId,
        agentName: input.agentName,
        skillName: input.skillName,
        envName: input.envName,
        scope: input.scope,
        userId: input.userId,
        codeVerifier,
        redirectUri: input.redirectUri,
        tokenUrl: input.tokenUrl,
        clientId: effectiveClientId,
        clientSecret: effectiveSecret,
        provider: input.provider,
        scopes: input.scopes,
        createdAt: now(),
      });

      const params = new URLSearchParams({
        client_id: effectiveClientId,
        redirect_uri: input.redirectUri,
        scope: input.scopes.join(' '),
        response_type: 'code',
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        state,
      });

      logger.info('admin_oauth_flow_started', {
        agentId: input.agentId,
        skillName: input.skillName,
        envName: input.envName,
        provider: input.provider,
        hasAdminOverride: !!input.adminOverride,
      });

      return { state, authUrl: `${input.authorizationUrl}?${params.toString()}` };
    },

    claim(state) {
      sweepExpired();
      const flow = flows.get(state);
      if (!flow) return undefined;
      flows.delete(state);
      return flow;
    },

    size() {
      sweepExpired();
      return flows.size;
    },
  };
}
