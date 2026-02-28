import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  exchangeCodeForTokens,
  refreshOAuthTokens,
  startCallbackServer,
  runOAuthFlow,
} from '../../src/host/oauth.js';

describe('OAuth PKCE Flow', () => {
  // ── PKCE Helpers ──

  test('generateCodeVerifier returns a base64url string', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toBeTruthy();
    expect(verifier.length).toBeGreaterThan(20);
    // base64url charset: A-Z, a-z, 0-9, -, _
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('generateCodeVerifier produces unique values', () => {
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });

  test('generateCodeChallenge produces SHA-256 base64url hash', () => {
    const verifier = 'test-verifier-1234';
    const challenge = generateCodeChallenge(verifier);
    expect(challenge).toBeTruthy();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // Same input → same output
    expect(generateCodeChallenge(verifier)).toBe(challenge);
  });

  test('generateCodeChallenge differs from verifier', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    expect(challenge).not.toBe(verifier);
  });

  test('generateState returns a hex string', () => {
    const state = generateState();
    expect(state).toMatch(/^[0-9a-f]+$/);
    expect(state.length).toBe(32); // 16 bytes = 32 hex chars
  });

  // ── Token Exchange (mocked fetch) ──

  describe('exchangeCodeForTokens', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test('sends correct parameters and returns tokens', async () => {
      let capturedUrl = '';
      let capturedBody = '';

      globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = url.toString();
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat01-test-access',
            refresh_token: 'sk-ant-ort01-test-refresh',
            expires_in: 7200,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const tokens = await exchangeCodeForTokens('auth-code-123', 'verifier-456', 'state-789');

      expect(capturedUrl).toBe('https://console.anthropic.com/v1/oauth/token');
      const parsed = JSON.parse(capturedBody);
      expect(parsed.grant_type).toBe('authorization_code');
      expect(parsed.code).toBe('auth-code-123');
      expect(parsed.code_verifier).toBe('verifier-456');
      expect(parsed.state).toBe('state-789');
      expect(parsed.client_id).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');

      expect(tokens.access_token).toBe('sk-ant-oat01-test-access');
      expect(tokens.refresh_token).toBe('sk-ant-ort01-test-refresh');
      expect(tokens.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test('throws on non-200 response', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('Unauthorized', { status: 401 });
      }) as typeof fetch;

      await expect(exchangeCodeForTokens('bad-code', 'verifier', 'state')).rejects.toThrow(
        'Token exchange failed (401)',
      );
    });
  });

  // ── Token Refresh (mocked fetch) ──

  describe('refreshOAuthTokens', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    test('sends refresh_token grant and returns new tokens', async () => {
      let capturedBody = '';

      globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            access_token: 'sk-ant-oat01-new-access',
            refresh_token: 'sk-ant-ort01-new-refresh',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const tokens = await refreshOAuthTokens('sk-ant-ort01-old-refresh');

      const parsed = JSON.parse(capturedBody);
      expect(parsed.grant_type).toBe('refresh_token');
      expect(parsed.refresh_token).toBe('sk-ant-ort01-old-refresh');

      expect(tokens.access_token).toBe('sk-ant-oat01-new-access');
      expect(tokens.refresh_token).toBe('sk-ant-ort01-new-refresh');
      expect(tokens.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    });

    test('throws on refresh failure', async () => {
      globalThis.fetch = vi.fn(async () => {
        return new Response('Token expired', { status: 400 });
      }) as typeof fetch;

      await expect(refreshOAuthTokens('expired-token')).rejects.toThrow(
        'Token refresh failed (400)',
      );
    });
  });

  // ── Callback Server ──
  // Each test uses a unique port to avoid EADDRINUSE conflicts

  describe('startCallbackServer', () => {
    test('receives auth code with valid state', async () => {
      const port = 14550;
      const state = 'test-state-abc';
      const serverPromise = startCallbackServer(state, port);

      await new Promise((r) => setTimeout(r, 100));

      const res = await fetch(`http://127.0.0.1:${port}/callback?code=auth-code-xyz&state=${state}`);
      expect(res.status).toBe(200);

      const { code, server } = await serverPromise;
      expect(code).toBe('auth-code-xyz');
      await new Promise<void>((r) => server.close(() => r()));
    });

    test('rejects on state mismatch', async () => {
      const port = 14551;
      const serverPromise = startCallbackServer('expected-state', port);
      // Attach rejection handler BEFORE triggering it to avoid unhandled rejection warning
      const rejection = serverPromise.catch((err: Error) => err);
      await new Promise((r) => setTimeout(r, 100));

      await fetch(`http://127.0.0.1:${port}/callback?code=auth-code&state=wrong-state`);

      const err = await rejection;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('state mismatch');
    });

    test('rejects on OAuth error', async () => {
      const port = 14552;
      const serverPromise = startCallbackServer('test-state', port);
      const rejection = serverPromise.catch((err: Error) => err);
      await new Promise((r) => setTimeout(r, 100));

      await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=test-state`);

      const err = await rejection;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain('OAuth error: access_denied');
    });
  });

  // ── TTY Hang Prevention ──

  describe('non-TTY hang prevention', () => {
    const originalIsTTY = process.stdin.isTTY;
    const originalDisplay = process.env.DISPLAY;
    const originalWayland = process.env.WAYLAND_DISPLAY;
    const originalPlatform = process.platform;

    afterEach(() => {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, writable: true, configurable: true });
      if (originalDisplay !== undefined) {
        process.env.DISPLAY = originalDisplay;
      } else {
        delete process.env.DISPLAY;
      }
      if (originalWayland !== undefined) {
        process.env.WAYLAND_DISPLAY = originalWayland;
      } else {
        delete process.env.WAYLAND_DISPLAY;
      }
      Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
    });

    test('runOAuthFlow throws immediately in headless non-TTY context', async () => {
      // Simulate headless Linux without TTY — this would hang forever before the fix
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

      await expect(runOAuthFlow()).rejects.toThrow('no browser available');
    });

    test('error message suggests ANTHROPIC_API_KEY as alternative', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux', writable: true, configurable: true });
      delete process.env.DISPLAY;
      delete process.env.WAYLAND_DISPLAY;
      Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });

      await expect(runOAuthFlow()).rejects.toThrow('ANTHROPIC_API_KEY');
    });
  });
});
