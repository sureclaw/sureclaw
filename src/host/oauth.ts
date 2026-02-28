/**
 * OAuth PKCE flow for Claude Max authentication.
 *
 * Uses node:http for the callback server, node:crypto for PKCE,
 * and global fetch for token exchange. Zero new dependencies.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createInterface } from 'node:readline';

// OAuth endpoints and client config
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'http://localhost:1455/callback';
const SCOPES = 'org:create_api_key user:profile user:inference';

export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}

// ── PKCE Helpers ──

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function generateState(): string {
  return randomBytes(16).toString('hex');
}

// ── Callback Server ──

/**
 * Start a local HTTP server on 127.0.0.1:1455 to receive the OAuth callback.
 * Validates the state parameter and returns the authorization code.
 */
export function startCallbackServer(expectedState: string, port = 1455): Promise<{ code: string; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Authorization failed</h2><p>You can close this tab.</p></body></html>');
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Invalid state parameter</h2></body></html>');
        server.close();
        reject(new Error('OAuth state mismatch — possible CSRF'));
        return;
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<html><body><h2>Missing authorization code</h2></body></html>');
        server.close();
        reject(new Error('No authorization code in callback'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>');
      resolve({ code, server });
    });

    server.listen(port, '127.0.0.1', () => {
      // Server is ready
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });
  });
}

// ── Token Exchange ──

/**
 * Exchange an authorization code for tokens.
 */
export async function exchangeCodeForTokens(code: string, codeVerifier: string, state: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

/**
 * Refresh an expired OAuth token.
 */
export async function refreshOAuthTokens(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const expiresIn = (data.expires_in as number) || 3600;

  return {
    access_token: data.access_token as string,
    refresh_token: data.refresh_token as string,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
  };
}

// ── Manual code entry (paste-based fallback) ──

/**
 * Wait for the user to paste the redirect URL from their browser.
 * After authorizing, the browser redirects to localhost:1455/callback?code=...&state=...
 * which won't load. The user copies the URL from the address bar and pastes it here.
 */
function waitForPastedCode(expectedState: string): Promise<string> {
  // If stdin is not a TTY, rl.question() will hang forever waiting for
  // input that will never come. Fail fast with a clear message instead.
  if (!process.stdin.isTTY) {
    return Promise.reject(new Error(
      'OAuth paste flow requires an interactive terminal (TTY). ' +
      'In non-interactive environments (cron, systemd, CI), use an API key instead: ' +
      'export ANTHROPIC_API_KEY=sk-ant-...',
    ));
  }

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    rl.question('  Paste the URL from your browser: ', (answer: string) => {
      rl.close();

      const trimmed = answer.trim();
      if (!trimmed) {
        reject(new Error('No URL provided'));
        return;
      }

      try {
        // Parse the pasted URL to extract code and state
        const url = new URL(trimmed);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          reject(new Error(`OAuth error: ${error}`));
          return;
        }
        if (state !== expectedState) {
          reject(new Error('OAuth state mismatch — possible CSRF'));
          return;
        }
        if (!code) {
          reject(new Error('No authorization code found in URL'));
          return;
        }

        resolve(code);
      } catch {
        reject(new Error('Invalid URL — paste the full URL from your browser address bar'));
      }
    });
  });
}

// ── Full Interactive Flow ──

/**
 * Run the full OAuth PKCE flow:
 * 1. Generate PKCE verifier/challenge + state
 * 2. Try to start local callback server (may fail if port is busy)
 * 3. Open browser to authorization URL
 * 4. Wait for callback OR manual URL paste
 * 5. Exchange code for tokens
 */
export async function runOAuthFlow(): Promise<OAuthTokens> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authUrl = new URL(AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('scope', SCOPES);
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  // Detect headless: no DISPLAY, no WAYLAND_DISPLAY, not macOS/Windows
  const isHeadless = process.platform === 'linux'
    && !process.env.DISPLAY
    && !process.env.WAYLAND_DISPLAY;

  // Try to start the callback server on machines with a browser.
  // On headless servers, skip it — the redirect goes to the user's local
  // browser, not this machine, so the callback server can't catch it.
  let callbackPromise: Promise<{ code: string; server: Server }> | null = null;
  if (!isHeadless) {
    try {
      callbackPromise = startCallbackServer(state);
    } catch {
      // Callback server failed to start — fall through to manual paste
    }
  }

  console.log('\n  Open this URL in your browser to authorize AX:\n');
  console.log(`  ${authUrl.toString()}\n`);

  // Try to open the browser (best-effort, will fail silently on headless).
  // Uses spawn (not exec) to avoid shell injection via the URL string.
  if (!isHeadless) {
    const { spawn } = await import('node:child_process');
    const openCmd = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open';
    // nosemgrep: javascript.lang.security.detect-child-process
    spawn(openCmd, [authUrl.toString()], { stdio: 'ignore', detached: true }).unref();
  }

  let code: string;

  if (callbackPromise) {
    // Desktop: race between auto-redirect and manual paste
    console.log('  After authorizing, you\'ll be redirected back automatically.');
    console.log('  If the redirect fails, copy the URL from your browser and paste it below.\n');

    const pastePromise = waitForPastedCode(state);
    const result = await Promise.race([
      callbackPromise.then(({ code: c, server }) => { server.close(); return c; }),
      pastePromise,
    ]);
    code = result;
  } else {
    // Headless: paste-only flow. If stdin is not a TTY either, there is
    // no way to complete the OAuth flow — fail fast with a clear message.
    if (!process.stdin.isTTY) {
      throw new Error(
        'OAuth flow cannot proceed: no browser available (headless) and no terminal (non-TTY). ' +
        'Set ANTHROPIC_API_KEY instead, or run `ax configure` from an interactive terminal first.',
      );
    }
    console.log('  After authorizing, your browser will redirect to a localhost URL.');
    console.log('  The page won\'t load — that\'s expected.');
    console.log('  Copy the full URL from your browser\'s address bar and paste it here.\n');

    code = await waitForPastedCode(state);
  }

  const tokens = await exchangeCodeForTokens(code, codeVerifier, state);

  console.log('  Authorization successful!\n');
  return tokens;
}
