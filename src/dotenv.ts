/**
 * Minimal .env loader for AX.
 *
 * Reads key=value pairs from ~/.ax/.env into process.env.
 * Safe to call multiple times — skips keys already set in the environment.
 *
 * After loading, checks if an OAuth token needs refreshing and updates
 * both process.env and the .env file with new tokens.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { envPath } from './paths.js';

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

  // Auto-refresh OAuth token if expired or within 5 minutes of expiry.
  // Await the refresh so credentials are ready before the server starts.
  await maybeRefreshOAuthToken(envPathResolved);
}

/**
 * Check if the OAuth token needs refreshing and refresh it before returning.
 * Must complete before the server starts so the proxy has valid credentials.
 */
async function maybeRefreshOAuthToken(envFilePath: string): Promise<void> {
  const refreshToken = process.env.AX_OAUTH_REFRESH_TOKEN;
  const expiresAtStr = process.env.AX_OAUTH_EXPIRES_AT;

  if (!refreshToken || !expiresAtStr) return;

  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt)) return;

  const nowSec = Math.floor(Date.now() / 1000);
  const FIVE_MINUTES = 300;

  if (nowSec < expiresAt - FIVE_MINUTES) return; // Token still valid

  // Token expired or about to expire — refresh before server starts
  try {
    await refreshOAuthTokenAsync(refreshToken, envFilePath);
  } catch (err) {
    // Refresh failed — warn clearly so the user knows why requests will fail
    const { getLogger } = await import('./logger.js');
    getLogger().warn('oauth_refresh_failed', {
      error: (err as Error).message,
      suggestion: 'Run `ax configure` to re-authenticate',
    });
  }
}

async function refreshOAuthTokenAsync(refreshToken: string, envFilePath: string): Promise<void> {
  const { refreshOAuthTokens } = await import('./host/oauth.js');
  const tokens = await refreshOAuthTokens(refreshToken);

  // Update process.env
  process.env.CLAUDE_CODE_OAUTH_TOKEN = tokens.access_token;
  process.env.AX_OAUTH_REFRESH_TOKEN = tokens.refresh_token;
  process.env.AX_OAUTH_EXPIRES_AT = String(tokens.expires_at);

  // Rewrite .env file with updated tokens
  updateEnvFile(envFilePath, {
    CLAUDE_CODE_OAUTH_TOKEN: tokens.access_token,
    AX_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
    AX_OAUTH_EXPIRES_AT: String(tokens.expires_at),
  });
}

/**
 * Update specific key=value pairs in an existing .env file,
 * preserving all other content (comments, other keys, ordering).
 */
function updateEnvFile(filePath: string, updates: Record<string, string>): void {
  if (!existsSync(filePath)) return;

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const remaining = { ...updates };

  const updated = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in remaining) {
      const val = remaining[key];
      delete remaining[key];
      return `${key}=${val}`;
    }
    return line;
  });

  // Append any keys that weren't already in the file
  for (const [key, val] of Object.entries(remaining)) {
    updated.push(`${key}=${val}`);
  }

  writeFileSync(filePath, updated.join('\n'), 'utf-8');
}
