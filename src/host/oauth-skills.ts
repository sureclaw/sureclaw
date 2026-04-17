/**
 * OAuth PKCE flow for skill credentials.
 *
 * Manages pending OAuth flows (start → callback → token exchange → store),
 * and handles token refresh for expired credentials. Uses event bus for
 * cross-replica coordination instead of in-memory resolveCredential().
 */

import { generateCodeVerifier, generateCodeChallenge, generateState } from './oauth.js';
import { getLogger } from '../logger.js';
import type { OAuthRequirement } from '../providers/skills/types.js';
import type { CredentialProvider } from '../providers/credentials/types.js';
import type { EventBus } from './event-bus.js';

const logger = getLogger().child({ component: 'oauth-skills' });

/** OAuth token endpoint timeout. 15s balances slow enterprise IdPs against
 * DoS exposure from hostile/stuck servers; longer hangs keep a pending flow
 * state consumed and the HTTP request queued. */
const TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

/** Stored credential blob — self-contained for refresh. */
export interface OAuthCredentialBlob {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_url: string;
  client_id: string;
  client_secret_env?: string;
  scopes: string[];
}

interface PendingOAuthFlow {
  sessionId: string;
  requestId: string;
  requirement: OAuthRequirement;
  codeVerifier: string;
  redirectUri: string;
}

/** state → PendingOAuthFlow */
const pendingFlows = new Map<string, PendingOAuthFlow>();

/** sessionId → Set<state> (for cleanup) */
const sessionStates = new Map<string, Set<string>>();

/**
 * Start an OAuth flow — generates PKCE params, stores pending state,
 * returns the full authorization URL for the client to open.
 */
export function startOAuthFlow(
  sessionId: string,
  requestId: string,
  req: OAuthRequirement,
  redirectUri: string,
): string {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingFlows.set(state, { sessionId, requestId, requirement: req, codeVerifier, redirectUri });

  let states = sessionStates.get(sessionId);
  if (!states) {
    states = new Set();
    sessionStates.set(sessionId, states);
  }
  states.add(state);

  const params = new URLSearchParams({
    client_id: req.client_id,
    redirect_uri: redirectUri,
    scope: req.scopes.join(' '),
    response_type: 'code',
    code_challenge_method: 'S256',
    code_challenge: codeChallenge,
    state,
  });

  logger.info('oauth_flow_started', { sessionId, name: req.name });
  return `${req.authorize_url}?${params.toString()}`;
}

/**
 * Handle the OAuth callback — validate state, exchange code for tokens,
 * store the credential blob, and emit credential.resolved via event bus.
 */
export async function resolveOAuthCallback(
  provider: string,
  code: string,
  state: string,
  credentials: CredentialProvider,
  eventBus: EventBus,
): Promise<boolean> {
  const flow = pendingFlows.get(state);
  if (!flow) {
    logger.warn('oauth_callback_invalid_state', { provider, state });
    return false;
  }

  const { requirement: req, codeVerifier, redirectUri, sessionId, requestId } = flow;

  // Remove pending state only after extracting flow data
  pendingFlows.delete(state);
  const states = sessionStates.get(flow.sessionId);
  states?.delete(state);
  if (states?.size === 0) sessionStates.delete(flow.sessionId);

  try {
    // Resolve client_secret if needed
    let clientSecret: string | undefined;
    if (req.client_secret_env) {
      clientSecret = await credentials.get(req.client_secret_env) ?? undefined;
    }

    // Exchange authorization code for tokens (RFC 6749 §4.1.3: form-urlencoded)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: req.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    if (clientSecret) body.set('client_secret', clientSecret);

    const res = await fetch(req.token_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error('oauth_token_exchange_failed', { provider, status: res.status, body: text });
      return false;
    }

    const data = await res.json() as Record<string, unknown>;
    const expiresIn = (data.expires_in as number) || 3600;

    const blob: OAuthCredentialBlob = {
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      expires_at: Math.floor(Date.now() / 1000) + expiresIn,
      token_url: req.token_url,
      client_id: req.client_id,
      ...(req.client_secret_env ? { client_secret_env: req.client_secret_env } : {}),
      scopes: req.scopes,
    };

    // Store in credential provider
    const credKey = `oauth:${req.name}`;
    await credentials.set(credKey, JSON.stringify(blob));
    logger.info('oauth_tokens_stored', { provider, credKey });
    return true;
  } catch (err) {
    logger.error('oauth_callback_error', { provider, error: (err as Error).message });
    return false;
  }
}

/**
 * Refresh an expired OAuth token. Reads the stored blob, POSTs to token_url,
 * and writes the updated blob back. Returns the new access_token, or null
 * if the credential doesn't exist or refresh fails.
 */
export async function refreshOAuthToken(
  credKey: string,
  credentials: CredentialProvider,
): Promise<string | null> {
  const raw = await credentials.get(credKey);
  if (!raw) return null;

  let blob: OAuthCredentialBlob;
  try {
    blob = JSON.parse(raw);
  } catch {
    logger.warn('oauth_blob_parse_failed', { credKey });
    return null;
  }

  // Check if still valid (5-minute buffer)
  const now = Math.floor(Date.now() / 1000);
  if (blob.expires_at > now + 300) {
    return blob.access_token;
  }

  // Resolve client_secret if needed
  let clientSecret: string | undefined;
  if (blob.client_secret_env) {
    clientSecret = await credentials.get(blob.client_secret_env) ?? undefined;
  }

  logger.info('oauth_token_refreshing', { credKey });

  // RFC 6749 §6: refresh requests use form-urlencoded
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: blob.client_id,
    refresh_token: blob.refresh_token,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const res = await fetch(blob.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('oauth_token_refresh_failed', { credKey, status: res.status, body: text });
    return null;
  }

  const data = await res.json() as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  blob.access_token = data.access_token as string;
  blob.refresh_token = (data.refresh_token as string) ?? blob.refresh_token;
  blob.expires_at = now + expiresIn;

  await credentials.set(credKey, JSON.stringify(blob));
  logger.info('oauth_token_refreshed', { credKey });
  return blob.access_token;
}

/**
 * Clean up all pending OAuth flows for a session.
 */
export function cleanupSession(sessionId: string): void {
  const states = sessionStates.get(sessionId);
  if (states) {
    for (const state of states) {
      pendingFlows.delete(state);
    }
    sessionStates.delete(sessionId);
  }
}
