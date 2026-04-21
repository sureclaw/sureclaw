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
import type { AuditProvider } from '../providers/audit/types.js';
import type { SkillCredStore } from './skills/skill-cred-store.js';
import type { SnapshotCache } from './skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from './skills/types.js';
import { invalidateCatalog } from './tool-catalog/cache.js';

const logger = getLogger().child({ component: 'admin-oauth-flow' });

const TTL_MS = 15 * 60 * 1000; // 15 minutes

/** OAuth token endpoint timeout. 15s balances slow enterprise IdPs against
 * DoS exposure from hostile/stuck servers; longer hangs keep a pending flow
 * state consumed and the HTTP request queued. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

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

export interface ResolveCallbackInput {
  provider: string;
  code: string;
  state: string;
  /** Tuple-keyed store. Tokens land here keyed by
   *  `(agentId, skillName, envName, userId|'')` so turn-time injection can
   *  find them. */
  skillCredStore: SkillCredStore;
  /** Optional — invalidated after credentials land so the next live read
   *  picks up the freshly-enabled skill without waiting for a push. */
  snapshotCache?: SnapshotCache<SkillSnapshotEntry[]>;
  audit: AuditProvider;
}

export type ResolveCallbackResult =
  | { matched: false }
  | { matched: true; ok: true }
  | {
      matched: true;
      ok: false;
      reason: 'token_exchange_failed' | 'invalid_response' | 'error';
      details?: string;
    };

export interface AdminOAuthFlow {
  /** Generate PKCE params + state, store the pending flow, return { state, authUrl }. */
  start(input: StartFlowInput): { state: string; authUrl: string };

  /** Look up and REMOVE a pending flow. Returns undefined when the state is
   *  unknown or the entry has exceeded its TTL. Single-use by design —
   *  a callback replay attempt with the same state yields undefined. */
  claim(state: string): AdminOAuthPendingFlow | undefined;

  /**
   * Exchange an authorization code for tokens, write the access token at the
   * declared scope, store a refresh blob (best-effort), and invalidate the
   * agent's snapshot cache.
   *
   * `matched: true` means this flow claimed the state — regardless of
   * exchange success. Callers MUST NOT fall through to any other OAuth path
   * when matched is true, even on `ok: false`. That rule keeps the agent-
   * initiated callback from silently handling an admin-provenance state.
   */
  resolveCallback(input: ResolveCallbackInput): Promise<ResolveCallbackResult>;

  /** For tests. Number of live (non-expired) flows. */
  size(): number;
}

export interface CreateAdminOAuthFlowOpts {
  /** For tests. Override the clock. */
  now?: () => number;
  /** For tests. Override the token-exchange fetch timeout (ms). Defaults to
   *  `TOKEN_EXCHANGE_TIMEOUT_MS` (15s). */
  tokenExchangeTimeoutMs?: number;
}

export function createAdminOAuthFlow(opts: CreateAdminOAuthFlowOpts = {}): AdminOAuthFlow {
  const now = opts.now ?? (() => Date.now());
  const tokenExchangeTimeoutMs = opts.tokenExchangeTimeoutMs ?? TOKEN_EXCHANGE_TIMEOUT_MS;
  const flows = new Map<string, AdminOAuthPendingFlow>();

  function sweepExpired(): void {
    const cutoff = now() - TTL_MS;
    for (const [state, flow] of flows) {
      if (flow.createdAt < cutoff) flows.delete(state);
    }
  }

  function claimState(state: string): AdminOAuthPendingFlow | undefined {
    sweepExpired();
    const flow = flows.get(state);
    if (!flow) return undefined;
    flows.delete(state);
    return flow;
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
      return claimState(state);
    },

    async resolveCallback(input) {
      const flow = claimState(input.state);
      if (!flow) return { matched: false };

      // Provider path mismatch: we consumed the state (to prevent replay and
      // to block fall-through to the agent module), but we refuse to proceed.
      // A callback hitting /v1/oauth/callback/<different>?state=<real> shouldn't
      // produce a token exchange against the stored flow's tokenUrl — that
      // would let an attacker pivot an admin flow's callback into an
      // unexpected provider.
      if (flow.provider !== input.provider) {
        logger.warn('admin_oauth_callback_provider_mismatch', {
          agentId: flow.agentId,
          skillName: flow.skillName,
          expected: flow.provider,
          actual: input.provider,
        });
        await input.audit.log({
          action: 'oauth_callback_failed',
          sessionId: flow.agentId,
          args: {
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: flow.envName,
            provider: flow.provider,
            reason: 'provider_mismatch',
          },
        });
        return { matched: true, ok: false, reason: 'invalid_response', details: 'provider mismatch' };
      }

      // Build the token request. RFC 6749 §4.1.3 — application/x-www-form-urlencoded.
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: flow.redirectUri,
        client_id: flow.clientId,
        code_verifier: flow.codeVerifier,
      });
      if (flow.clientSecret) body.set('client_secret', flow.clientSecret);

      let res: Response;
      try {
        res = await fetch(flow.tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: body.toString(),
          signal: AbortSignal.timeout(tokenExchangeTimeoutMs),
        });
      } catch (err) {
        logger.error('admin_oauth_token_fetch_error', {
          agentId: flow.agentId,
          skillName: flow.skillName,
          provider: flow.provider,
          error: (err as Error).message,
        });
        await input.audit.log({
          action: 'oauth_callback_failed',
          sessionId: flow.agentId,
          args: {
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: flow.envName,
            provider: flow.provider,
            reason: 'fetch_error',
          },
        });
        return { matched: true, ok: false, reason: 'error', details: (err as Error).message };
      }

      if (!res.ok) {
        // Bounded body read — we log the length + status only.  NEVER the
        // body itself: upstream errors can include sensitive echo-back of
        // the client_secret or authorization code.
        let bodyLength = 0;
        try {
          const text = await res.text();
          bodyLength = text.length;
        } catch {
          // ignore — we already have enough to log.
        }
        logger.error('admin_oauth_token_exchange_failed', {
          agentId: flow.agentId,
          skillName: flow.skillName,
          provider: flow.provider,
          status: res.status,
          bodyLength,
        });
        await input.audit.log({
          action: 'oauth_callback_failed',
          sessionId: flow.agentId,
          args: {
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: flow.envName,
            provider: flow.provider,
            status: res.status,
          },
        });
        return { matched: true, ok: false, reason: 'token_exchange_failed' };
      }

      let data: Record<string, unknown>;
      try {
        data = (await res.json()) as Record<string, unknown>;
      } catch (err) {
        logger.error('admin_oauth_token_response_parse_failed', {
          agentId: flow.agentId,
          skillName: flow.skillName,
          provider: flow.provider,
          error: (err as Error).message,
        });
        await input.audit.log({
          action: 'oauth_callback_failed',
          sessionId: flow.agentId,
          args: {
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: flow.envName,
            provider: flow.provider,
            reason: 'parse_error',
          },
        });
        return { matched: true, ok: false, reason: 'invalid_response', details: 'json parse failed' };
      }

      const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
      if (!accessToken) {
        logger.error('admin_oauth_token_missing_access_token', {
          agentId: flow.agentId,
          skillName: flow.skillName,
          provider: flow.provider,
        });
        await input.audit.log({
          action: 'oauth_callback_failed',
          sessionId: flow.agentId,
          args: {
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: flow.envName,
            provider: flow.provider,
            reason: 'missing_access_token',
          },
        });
        return { matched: true, ok: false, reason: 'invalid_response', details: 'missing access_token' };
      }

      // `admin` is the safe fallback when a user-scoped flow somehow lost
      // its userId. `storeUserId` is '' for agent-scope, the resolved userId
      // for user-scope.
      const effectiveUserId = flow.userId ?? 'admin';
      const storeUserId = flow.scope === 'agent' ? '' : effectiveUserId;

      await input.skillCredStore.put({
        agentId: flow.agentId,
        skillName: flow.skillName,
        envName: flow.envName,
        userId: storeUserId,
        value: accessToken,
      });

      const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : undefined;
      const expiresIn = typeof data.expires_in === 'number' ? data.expires_in : 3600;

      if (refreshToken) {
        const blob = {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_at: Math.floor(Date.now() / 1000) + expiresIn,
          token_url: flow.tokenUrl,
          client_id: flow.clientId,
          scopes: flow.scopes,
        };
        try {
          await input.skillCredStore.put({
            agentId: flow.agentId,
            skillName: flow.skillName,
            envName: `${flow.envName}__oauth_blob`,
            userId: storeUserId,
            value: JSON.stringify(blob),
          });
        } catch (err) {
          // Best-effort: access_token is already written. Next login flow
          // will re-seed the blob.
          logger.warn('admin_oauth_blob_write_failed', {
            agentId: flow.agentId,
            skillName: flow.skillName,
            error: (err as Error).message,
          });
        }
      }

      // Audit throws propagate — "Everything is audited" is a security
      // invariant. If audit blows up we surface it; credentials are already
      // written but a silent-success path would leave an evidence gap.
      await input.audit.log({
        action: 'oauth_callback_success',
        sessionId: flow.agentId,
        args: {
          agentId: flow.agentId,
          skillName: flow.skillName,
          envName: flow.envName,
          provider: flow.provider,
          hasRefreshToken: !!refreshToken,
        },
      });

      input.snapshotCache?.invalidateAgent(flow.agentId);
      // The freshly-landed credentials change the auth headers that
      // `resolveMcpAuthHeaders` returns, which can change the MCP
      // `listTools` response (e.g. different Linear workspace visible
      // under new token). Drop the per-turn catalog cache so the next
      // turn rebuilds with the new credentials.
      invalidateCatalog(flow.agentId);

      return { matched: true, ok: true };
    },

    size() {
      sweepExpired();
      return flows.size;
    },
  };
}
