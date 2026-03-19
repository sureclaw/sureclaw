import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock global fetch for token exchange tests
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

describe('oauth-skills', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('startOAuthFlow returns authorize URL with PKCE params', async () => {
    const { startOAuthFlow } = await import('../../src/host/oauth-skills.js');

    const url = startOAuthFlow('sess-1', {
      name: 'LINEAR_API_KEY',
      authorize_url: 'https://linear.app/oauth/authorize',
      token_url: 'https://linear.app/oauth/token',
      scopes: ['read', 'write'],
      client_id: 'abc123',
    }, 'http://localhost:8080/v1/oauth/callback/LINEAR_API_KEY');

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://linear.app/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('abc123');
    expect(parsed.searchParams.get('redirect_uri')).toBe('http://localhost:8080/v1/oauth/callback/LINEAR_API_KEY');
    expect(parsed.searchParams.get('scope')).toBe('read write');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
    expect(parsed.searchParams.get('state')).toBeTruthy();
  });

  test('resolveOAuthCallback exchanges code and resolves pending flow', async () => {
    const { startOAuthFlow, resolveOAuthCallback, cleanupSession } = await import('../../src/host/oauth-skills.js');

    // Start a flow to create the pending entry
    const url = startOAuthFlow('sess-2', {
      name: 'GH_TOKEN',
      authorize_url: 'https://github.com/login/oauth/authorize',
      token_url: 'https://github.com/login/oauth/access_token',
      scopes: ['repo'],
      client_id: 'gh-123',
    }, 'http://localhost:8080/v1/oauth/callback/GH_TOKEN');

    const state = new URL(url).searchParams.get('state')!;

    // Mock token exchange response
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'gho_access_123',
        refresh_token: 'ghr_refresh_456',
        expires_in: 3600,
      }),
    });

    const mockCredentials = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    const result = await resolveOAuthCallback('GH_TOKEN', 'auth-code-xyz', state, mockCredentials);
    expect(result).toBe(true);

    // Should have stored the credential blob
    expect(mockCredentials.set).toHaveBeenCalledOnce();
    const [key, value] = mockCredentials.set.mock.calls[0];
    expect(key).toBe('oauth:GH_TOKEN');
    const blob = JSON.parse(value);
    expect(blob.access_token).toBe('gho_access_123');
    expect(blob.refresh_token).toBe('ghr_refresh_456');
    expect(blob.token_url).toBe('https://github.com/login/oauth/access_token');
    expect(blob.client_id).toBe('gh-123');

    cleanupSession('sess-2');
  });

  test('resolveOAuthCallback returns false for invalid state', async () => {
    const { resolveOAuthCallback } = await import('../../src/host/oauth-skills.js');

    const mockCredentials = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    const result = await resolveOAuthCallback('UNKNOWN', 'code', 'bad-state', mockCredentials);
    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('refreshOAuthToken refreshes expired token and updates stored blob', async () => {
    const { refreshOAuthToken } = await import('../../src/host/oauth-skills.js');

    const expiredBlob = JSON.stringify({
      access_token: 'old_access',
      refresh_token: 'refresh_tok',
      expires_at: Math.floor(Date.now() / 1000) - 3600, // expired 1h ago
      token_url: 'https://api.example.com/oauth/token',
      client_id: 'client-1',
      scopes: ['read'],
    });

    const mockCredentials = {
      get: vi.fn().mockResolvedValue(expiredBlob),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'new_access_tok',
        refresh_token: 'new_refresh_tok',
        expires_in: 7200,
      }),
    });

    const newToken = await refreshOAuthToken('oauth:TEST_KEY', mockCredentials);
    expect(newToken).toBe('new_access_tok');

    // Should have updated the stored blob
    const [key, value] = mockCredentials.set.mock.calls[0];
    expect(key).toBe('oauth:TEST_KEY');
    const blob = JSON.parse(value);
    expect(blob.access_token).toBe('new_access_tok');
    expect(blob.refresh_token).toBe('new_refresh_tok');
    expect(blob.token_url).toBe('https://api.example.com/oauth/token');
  });

  test('refreshOAuthToken returns null when no stored credential', async () => {
    const { refreshOAuthToken } = await import('../../src/host/oauth-skills.js');

    const mockCredentials = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    };

    const result = await refreshOAuthToken('oauth:MISSING', mockCredentials);
    expect(result).toBeNull();
  });

  test('refreshOAuthToken includes client_secret when client_secret_env is set', async () => {
    const { refreshOAuthToken } = await import('../../src/host/oauth-skills.js');

    const blob = JSON.stringify({
      access_token: 'old',
      refresh_token: 'ref_tok',
      expires_at: Math.floor(Date.now() / 1000) - 60,
      token_url: 'https://api.example.com/oauth/token',
      client_id: 'client-1',
      client_secret_env: 'MY_CLIENT_SECRET',
      scopes: ['read'],
    });

    const mockCredentials = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'oauth:WITH_SECRET') return blob;
        if (key === 'MY_CLIENT_SECRET') return 'super-secret-value';
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn(),
      list: vi.fn(),
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        access_token: 'refreshed',
        refresh_token: 'new_ref',
        expires_in: 3600,
      }),
    });

    await refreshOAuthToken('oauth:WITH_SECRET', mockCredentials);

    // Verify fetch was called with client_secret in the form-urlencoded body
    const fetchBody = new URLSearchParams(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.get('client_secret')).toBe('super-secret-value');
  });

  test('cleanupSession clears pending flows', async () => {
    const { startOAuthFlow, resolveOAuthCallback, cleanupSession } = await import('../../src/host/oauth-skills.js');

    const url = startOAuthFlow('sess-cleanup', {
      name: 'TEST',
      authorize_url: 'https://example.com/auth',
      token_url: 'https://example.com/token',
      scopes: [],
      client_id: 'c1',
    }, 'http://localhost/callback/TEST');

    const state = new URL(url).searchParams.get('state')!;

    cleanupSession('sess-cleanup');

    // resolveOAuthCallback should return false — pending was cleaned up
    const mockCredentials = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() };
    const result = await resolveOAuthCallback('TEST', 'code', state, mockCredentials);
    expect(result).toBe(false);
  });
});
