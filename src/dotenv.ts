/**
 * Minimal .env loader and OAuth token refresh for AX.
 *
 * loadDotEnv() reads key=value pairs from ~/.ax/.env into process.env.
 * Safe to call multiple times — skips keys already set in the environment.
 *
 * loadCredentials() seeds process.env from the credential provider
 * (credentials.yaml or keychain) so that synchronous readers like the
 * proxy can access tokens without going through the async provider API.
 *
 * OAuth refresh functions accept an optional CredentialProvider. When
 * provided, they persist refreshed tokens through the provider. When
 * not provided, they still update process.env (backward compat).
 */

import { existsSync, readFileSync } from 'node:fs';
import { envPath } from './paths.js';
import type { CredentialProvider } from './providers/credentials/types.js';

/**
 * Load ~/.ax/.env into process.env (simple key=value loader).
 * Still needed for AX_CREDS_PASSPHRASE and backward compat with
 * existing .env installs that haven't migrated to credentials.yaml.
 */
export async function loadDotEnv(): Promise<void> {
  const envPathResolved = envPath();
  if (!existsSync(envPathResolved)) return;
  const lines = readFileSync(envPathResolved, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

/** Keys to seed from the credential provider into process.env at startup. */
const SEED_KEYS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AX_OAUTH_REFRESH_TOKEN',
  'AX_OAUTH_EXPIRES_AT',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'TAVILY_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
];

/**
 * Seed process.env from the credential provider so synchronous readers
 * (e.g. the Anthropic proxy) can access tokens without the async API.
 * Also triggers OAuth refresh if the token is expired.
 */
export async function loadCredentials(provider: CredentialProvider): Promise<void> {
  for (const key of SEED_KEYS) {
    if (process.env[key] !== undefined) continue; // don't override shell exports
    const val = await provider.get(key);
    if (val !== null) process.env[key] = val;
  }

  // Auto-refresh OAuth if expired
  await ensureOAuthTokenFreshViaProvider(provider);
}

/**
 * Check if the OAuth token needs refreshing. Uses the credential provider
 * to persist refreshed tokens.
 */
export async function ensureOAuthTokenFreshViaProvider(provider: CredentialProvider): Promise<void> {
  const refreshToken = process.env.AX_OAUTH_REFRESH_TOKEN;
  const expiresAtStr = process.env.AX_OAUTH_EXPIRES_AT;

  if (!refreshToken || !expiresAtStr) return;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt)) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const FIVE_MINUTES = 300;

  if (nowSec < expiresAt - FIVE_MINUTES) return; // Token still valid

  try {
    const { refreshOAuthTokens } = await import('./host/oauth.js');
    const tokens = await refreshOAuthTokens(refreshToken);

    // Update process.env
    process.env.CLAUDE_CODE_OAUTH_TOKEN = tokens.access_token;
    process.env.AX_OAUTH_REFRESH_TOKEN = tokens.refresh_token;
    process.env.AX_OAUTH_EXPIRES_AT = String(tokens.expires_at);

    // Persist via credential provider
    await provider.set('CLAUDE_CODE_OAUTH_TOKEN', tokens.access_token);
    await provider.set('AX_OAUTH_REFRESH_TOKEN', tokens.refresh_token);
    await provider.set('AX_OAUTH_EXPIRES_AT', String(tokens.expires_at));
  } catch (err) {
    const { getLogger } = await import('./logger.js');
    getLogger().warn('oauth_refresh_failed', {
      error: (err as Error).message,
      suggestion: 'Run `ax configure` to re-authenticate',
    });
  }
}

/**
 * Check if the OAuth token needs refreshing (process.env only, no provider).
 * Backward-compat wrapper — prefers ensureOAuthTokenFreshViaProvider when
 * a credential provider is available.
 */
export async function ensureOAuthTokenFresh(): Promise<void> {
  const refreshToken = process.env.AX_OAUTH_REFRESH_TOKEN;
  const expiresAtStr = process.env.AX_OAUTH_EXPIRES_AT;

  if (!refreshToken || !expiresAtStr) return;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt)) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const FIVE_MINUTES = 300;

  if (nowSec < expiresAt - FIVE_MINUTES) return;

  try {
    await _doRefreshEnvOnly(refreshToken);
  } catch (err) {
    const { getLogger } = await import('./logger.js');
    getLogger().warn('oauth_refresh_failed', {
      error: (err as Error).message,
      suggestion: 'Run `ax configure` to re-authenticate',
    });
  }
}

/**
 * Force-refresh the OAuth token using the refresh token from process.env.
 * Updates process.env only. Exported for the proxy's reactive retry on 401.
 */
export async function refreshOAuthTokenFromEnv(): Promise<void> {
  const refreshToken = process.env.AX_OAUTH_REFRESH_TOKEN;
  if (!refreshToken) throw new Error('No refresh token available');
  await _doRefreshEnvOnly(refreshToken);
}

async function _doRefreshEnvOnly(refreshToken: string): Promise<void> {
  const { refreshOAuthTokens } = await import('./host/oauth.js');
  const tokens = await refreshOAuthTokens(refreshToken);

  process.env.CLAUDE_CODE_OAUTH_TOKEN = tokens.access_token;
  process.env.AX_OAUTH_REFRESH_TOKEN = tokens.refresh_token;
  process.env.AX_OAUTH_EXPIRES_AT = String(tokens.expires_at);
}
