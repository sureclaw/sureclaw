# Skill OAuth Credentials — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add OAuth authentication support for skills, so users can authenticate via browser redirect instead of pasting API keys.

**Architecture:** Extends the existing credential prompt system (`credential-prompts.ts`) with a parallel OAuth flow module (`oauth-skills.ts`). Reuses PKCE helpers from `oauth.ts`. The skill frontmatter parser gains `requires.oauth` support. The credential resolution loop in `server-completions.ts` handles OAuth entries first (with auto-refresh), then falls back to plain env prompts.

**Tech Stack:** Node.js crypto (PKCE), global fetch (token exchange), existing credential provider (string storage), existing SSE event bus.

**Design doc:** `docs/plans/2026-03-19-skill-oauth-credentials.md`

---

### Task 1: Extend Skill Types and Parser for `requires.oauth`

**Files:**
- Modify: `src/providers/skills/types.ts:24-43`
- Modify: `src/utils/skill-format-parser.ts:151-192`
- Test: `tests/host/collect-skill-env.test.ts`

**Step 1: Write the failing tests**

Add to `tests/host/collect-skill-env.test.ts`:

```typescript
test('parseAgentSkill extracts requires.oauth from skill frontmatter', async () => {
  const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

  const skill = `---
name: linear-bot
metadata:
  openclaw:
    requires:
      env:
        - SLACK_TOKEN
      oauth:
        - name: LINEAR_API_KEY
          authorize_url: https://linear.app/oauth/authorize
          token_url: https://linear.app/oauth/token
          scopes:
            - read
            - write
          client_id: abc123
          client_secret_env: LINEAR_OAUTH_CLIENT_SECRET
---
Linear integration.`;

  const parsed = parseAgentSkill(skill);
  expect(parsed.requires.oauth).toHaveLength(1);
  expect(parsed.requires.oauth![0]).toEqual({
    name: 'LINEAR_API_KEY',
    authorize_url: 'https://linear.app/oauth/authorize',
    token_url: 'https://linear.app/oauth/token',
    scopes: ['read', 'write'],
    client_id: 'abc123',
    client_secret_env: 'LINEAR_OAUTH_CLIENT_SECRET',
  });
  // Plain env still parsed
  expect(parsed.requires.env).toContain('SLACK_TOKEN');
});

test('parseAgentSkill returns empty oauth array when not declared', async () => {
  const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

  const skill = `---
name: simple
metadata:
  openclaw:
    requires:
      env:
        - API_KEY
---
Simple skill.`;

  const parsed = parseAgentSkill(skill);
  expect(parsed.requires.oauth).toEqual([]);
});

test('parseAgentSkill handles oauth without client_secret_env (PKCE-only)', async () => {
  const { parseAgentSkill } = await import('../../src/utils/skill-format-parser.js');

  const skill = `---
name: github-bot
metadata:
  openclaw:
    requires:
      oauth:
        - name: GITHUB_TOKEN
          authorize_url: https://github.com/login/oauth/authorize
          token_url: https://github.com/login/oauth/access_token
          scopes: [repo, user]
          client_id: gh-client-123
---
GitHub integration.`;

  const parsed = parseAgentSkill(skill);
  expect(parsed.requires.oauth).toHaveLength(1);
  expect(parsed.requires.oauth![0].client_secret_env).toBeUndefined();
  expect(parsed.requires.oauth![0].client_id).toBe('gh-client-123');
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/collect-skill-env.test.ts`
Expected: FAIL — `parsed.requires.oauth` is undefined

**Step 3: Add OAuthRequirement type to skills types**

In `src/providers/skills/types.ts`, add the interface and extend `ParsedAgentSkill.requires`:

```typescript
export interface OAuthRequirement {
  name: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id: string;
  client_secret_env?: string;
}

export interface ParsedAgentSkill {
  // ... existing fields ...
  requires: {
    bins: string[];
    env: string[];
    oauth: OAuthRequirement[];  // NEW
    anyBins?: string[][];
    config?: Record<string, string>;
  };
  // ... rest unchanged ...
}
```

**Step 4: Parse `requires.oauth` in skill-format-parser**

In `src/utils/skill-format-parser.ts`, add a parser helper and wire it into `parseAgentSkill()`.

Add helper function after `toStringArray`:

```typescript
function toOAuthRequirements(raw: unknown): OAuthRequirement[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      item !== null && typeof item === 'object' && typeof (item as any).name === 'string')
    .map(item => ({
      name: String(item.name),
      authorize_url: String(item.authorize_url ?? ''),
      token_url: String(item.token_url ?? ''),
      scopes: toStringArray(item.scopes),
      client_id: String(item.client_id ?? ''),
      ...(typeof item.client_secret_env === 'string' ? { client_secret_env: item.client_secret_env } : {}),
    }));
}
```

Add import for `OAuthRequirement` from `../providers/skills/types.js`.

In the `requires` block inside `parseAgentSkill()`, add after `env:`:

```typescript
oauth: toOAuthRequirements(requires?.oauth),
```

**Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/host/collect-skill-env.test.ts`
Expected: PASS (all tests including new ones)

**Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: Clean (no errors)

**Step 7: Commit**

```
feat: add requires.oauth parsing to skill frontmatter
```

---

### Task 2: Create `oauth-skills.ts` — PKCE Flow, Pending Registry, Token Exchange, Refresh

**Files:**
- Create: `src/host/oauth-skills.ts`
- Test: `tests/host/oauth-skills.test.ts`

**Step 1: Write the failing tests**

Create `tests/host/oauth-skills.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

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

    // Verify fetch was called with client_secret in the body
    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.client_secret).toBe('super-secret-value');
  });

  test('cleanupSession clears pending flows', async () => {
    const { startOAuthFlow, resolveOAuthCallback, cleanupSession } = await import('../../src/host/oauth-skills.js');

    startOAuthFlow('sess-cleanup', {
      name: 'TEST',
      authorize_url: 'https://example.com/auth',
      token_url: 'https://example.com/token',
      scopes: [],
      client_id: 'c1',
    }, 'http://localhost/callback/TEST');

    cleanupSession('sess-cleanup');

    // resolveOAuthCallback should return false — pending was cleaned up
    const mockCredentials = { get: vi.fn(), set: vi.fn(), delete: vi.fn(), list: vi.fn() };
    const result = await resolveOAuthCallback('TEST', 'code', 'any-state', mockCredentials);
    expect(result).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/oauth-skills.test.ts`
Expected: FAIL — module `../../src/host/oauth-skills.js` not found

**Step 3: Implement `src/host/oauth-skills.ts`**

```typescript
/**
 * OAuth PKCE flow for skill credentials.
 *
 * Manages pending OAuth flows (start → callback → token exchange → store),
 * and handles token refresh for expired credentials. Reuses PKCE helpers
 * from oauth.ts and the pending/resolve pattern from credential-prompts.ts.
 */

import { generateCodeVerifier, generateCodeChallenge, generateState } from './oauth.js';
import { resolveCredential } from './credential-prompts.js';
import { getLogger } from '../logger.js';
import type { OAuthRequirement } from '../providers/skills/types.js';
import type { CredentialProvider } from '../providers/credentials/types.js';

const logger = getLogger().child({ component: 'oauth-skills' });

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
  req: OAuthRequirement,
  redirectUri: string,
): string {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingFlows.set(state, { sessionId, requirement: req, codeVerifier, redirectUri });

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
 * store the credential blob, and resolve the pending credential prompt.
 */
export async function resolveOAuthCallback(
  provider: string,
  code: string,
  state: string,
  credentials: CredentialProvider,
): Promise<boolean> {
  const flow = pendingFlows.get(state);
  if (!flow) {
    logger.warn('oauth_callback_invalid_state', { provider, state });
    return false;
  }

  pendingFlows.delete(state);
  const states = sessionStates.get(flow.sessionId);
  states?.delete(state);
  if (states?.size === 0) sessionStates.delete(flow.sessionId);

  const { requirement: req, codeVerifier, redirectUri, sessionId } = flow;

  // Resolve client_secret if needed
  let clientSecret: string | undefined;
  if (req.client_secret_env) {
    clientSecret = await credentials.get(req.client_secret_env) ?? undefined;
  }

  // Exchange authorization code for tokens
  const res = await fetch(req.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: req.client_id,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('oauth_token_exchange_failed', { provider, status: res.status, body: text });
    resolveCredential(sessionId, req.name, '');
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

  // Resolve the pending credential prompt so processCompletion unblocks
  resolveCredential(sessionId, req.name, blob.access_token);
  return true;
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

  const res = await fetch(blob.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: blob.client_id,
      refresh_token: blob.refresh_token,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    }),
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
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/oauth-skills.test.ts`
Expected: PASS

**Step 5: Type-check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 6: Commit**

```
feat: add oauth-skills module for skill OAuth PKCE flows
```

---

### Task 3: Update Credential Resolution Loop in `server-completions.ts`

**Files:**
- Modify: `src/host/server-completions.ts:747-785` (credential resolution block)
- Modify: `src/host/server-completions.ts:1404-1437` (`collectSkillEnvRequirements` function)

**Step 1: Rename and extend `collectSkillEnvRequirements`**

Rename to `collectSkillCredentialRequirements`. Change return type from `Set<string>` to `{ env: Set<string>; oauth: OAuthRequirement[] }`. Parse both `requires.env` and `requires.oauth` from each skill file.

In `server-completions.ts`, update the function at line 1404:

```typescript
import type { OAuthRequirement } from '../providers/skills/types.js';

function collectSkillCredentialRequirements(
  agentSkillsDir?: string,
  userSkillsDir?: string,
): { env: Set<string>; oauth: OAuthRequirement[] } {
  const envVars = new Set<string>();
  const oauthReqs: OAuthRequirement[] = [];
  for (const dir of [agentSkillsDir, userSkillsDir]) {
    if (!dir || !existsSync(dir)) continue;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        try {
          let raw: string | undefined;
          if (entry.isFile() && entry.name.endsWith('.md')) {
            raw = readFileSync(join(dir, entry.name), 'utf-8');
          } else if (entry.isDirectory()) {
            const skillMdPath = join(dir, entry.name, 'SKILL.md');
            if (existsSync(skillMdPath)) {
              raw = readFileSync(skillMdPath, 'utf-8');
            }
          }
          if (raw) {
            const parsed = parseAgentSkill(raw);
            for (const env of parsed.requires.env) {
              envVars.add(env);
            }
            for (const oauth of parsed.requires.oauth) {
              oauthReqs.push(oauth);
            }
          }
        } catch { /* skip unparseable skills */ }
      }
    } catch { /* skip unreadable directories */ }
  }
  return { env: envVars, oauth: oauthReqs };
}
```

**Step 2: Update the credential resolution loop (line 747)**

Replace the existing block with OAuth-first resolution:

```typescript
    // Scan skill files for credential requirements (env vars + OAuth).
    const { env: skillEnvRequirements, oauth: skillOAuthRequirements } =
      collectSkillCredentialRequirements(
        agentWsPath ? join(agentWsPath, 'skills') : undefined,
        userWsPath ? join(userWsPath, 'skills') : undefined,
      );

    // Track which env names are handled by OAuth (so plain env prompt is skipped)
    const oauthHandledNames = new Set<string>();

    // --- OAuth credentials: check stored blob, refresh if expired, or start flow ---
    const hostPort = deps.port ?? 8080;
    const publicUrl = process.env.AX_PUBLIC_URL ?? `http://localhost:${hostPort}`;

    for (const oauthReq of skillOAuthRequirements) {
      oauthHandledNames.add(oauthReq.name);
      const credKey = `oauth:${oauthReq.name}`;
      const stored = await providers.credentials.get(credKey);

      if (stored) {
        // Credential exists — refresh if expired
        const { refreshOAuthToken } = await import('./oauth-skills.js');
        const accessToken = await refreshOAuthToken(credKey, providers.credentials);
        if (accessToken) {
          credentialMap.register(oauthReq.name, accessToken);
          reqLogger.debug('oauth_credential_resolved', { name: oauthReq.name, refreshed: true });
          continue;
        }
        // Refresh failed — fall through to re-auth
      }

      // No stored credential or refresh failed — start OAuth flow
      const { startOAuthFlow } = await import('./oauth-skills.js');
      const redirectUri = `${publicUrl}/v1/oauth/callback/${oauthReq.name}`;
      const authorizeUrl = startOAuthFlow(sessionId, oauthReq, redirectUri);

      reqLogger.info('oauth_prompt_emitting', { name: oauthReq.name });
      eventBus?.emit({
        type: 'oauth.required',
        requestId,
        timestamp: Date.now(),
        data: { envName: oauthReq.name, sessionId, authorizeUrl },
      });

      // Block until user completes OAuth or timeout
      const { requestCredential } = await import('./credential-prompts.js');
      const accessToken = await requestCredential(sessionId, oauthReq.name);
      if (accessToken) {
        credentialMap.register(oauthReq.name, accessToken);
        reqLogger.debug('oauth_credential_resolved', { name: oauthReq.name });
      } else {
        reqLogger.debug('oauth_credential_timeout', { name: oauthReq.name });
      }
    }

    // --- Plain env credentials: prompt for any not handled by OAuth ---
    for (const envName of skillEnvRequirements) {
      if (oauthHandledNames.has(envName)) continue;

      let realValue = await providers.credentials.get(envName);

      if (!realValue) {
        reqLogger.info('credential_prompt_emitting', { envName });
        eventBus?.emit({
          type: 'credential.required',
          requestId,
          timestamp: Date.now(),
          data: { envName, sessionId },
        });

        const { requestCredential } = await import('./credential-prompts.js');
        const provided = await requestCredential(sessionId, envName);
        if (provided) {
          await providers.credentials.set(envName, provided).catch(() => {
            reqLogger.debug('credential_store_failed', { envName });
          });
          realValue = provided;
        }
      }

      if (realValue) {
        credentialMap.register(envName, realValue);
        reqLogger.debug('credential_placeholder_registered', { envName });
      } else {
        reqLogger.debug('credential_not_found', { envName });
      }
    }
```

**Step 3: Add OAuth cleanup at end of processCompletion**

Near line 1332 where `web-proxy-approvals.cleanupSession` is called, also clean up OAuth:

```typescript
    // Clean up pending OAuth flows for this session
    {
      const { cleanupSession: cleanupOAuth } = await import('./oauth-skills.js');
      cleanupOAuth(sessionId);
    }
```

**Step 4: Run type-check and existing tests**

Run: `npx tsc --noEmit && npx vitest run tests/host/collect-skill-env.test.ts tests/host/server.test.ts`
Expected: Clean compile, all tests pass

**Step 5: Commit**

```
feat: OAuth-first credential resolution with auto-refresh
```

---

### Task 4: Add OAuth Callback Route and SSE Event to `server.ts`

**Files:**
- Modify: `src/host/server.ts:654-672` (after `/v1/credentials/provide` route)
- Modify: `src/host/server.ts:881-890` (SSE event listener)
- Test: `tests/host/server-credentials-sse.test.ts`

**Step 1: Write the SSE event format test**

Add to `tests/host/server-credentials-sse.test.ts`:

```typescript
test('sendSSENamedEvent emits oauth_required event format', async () => {
  const { sendSSENamedEvent } = await import('../../src/host/server-http.js');

  const chunks: string[] = [];
  const mockRes = {
    write: (data: string) => { chunks.push(data); return true; },
  };

  sendSSENamedEvent(mockRes as any, 'oauth_required', {
    envName: 'LINEAR_API_KEY',
    sessionId: 'sess-1',
    authorizeUrl: 'https://linear.app/oauth/authorize?client_id=abc&state=xyz',
  });

  expect(chunks.length).toBe(1);
  expect(chunks[0]).toContain('event: oauth_required\n');
  expect(chunks[0]).toContain('"envName":"LINEAR_API_KEY"');
  expect(chunks[0]).toContain('"authorizeUrl"');
  expect(chunks[0]).toContain('\n\n');
});
```

**Step 2: Run test to verify it passes immediately**

Run: `npx vitest run tests/host/server-credentials-sse.test.ts`
Expected: PASS (the SSE helper is generic — this test just validates the format)

**Step 3: Add OAuth callback route to `server.ts`**

After the `/v1/credentials/provide` route (around line 672), add:

```typescript
    // GET /v1/oauth/callback/:provider — OAuth redirect callback
    if (url.startsWith('/v1/oauth/callback/') && req.method === 'GET') {
      const provider = url.split('/v1/oauth/callback/')[1]?.split('?')[0];
      const params = new URL(req.url!, `http://${req.headers.host}`).searchParams;
      const code = params.get('code');
      const state = params.get('state');

      if (!provider || !code || !state) {
        sendError(res, 400, 'Missing required parameters: code, state');
        return;
      }

      try {
        const { resolveOAuthCallback } = await import('./oauth-skills.js');
        const found = await resolveOAuthCallback(provider, code, state, deps.providers.credentials);

        const html = found
          ? '<html><body><h2>Authentication successful</h2><p>You can close this tab and return to your conversation.</p></body></html>'
          : '<html><body><h2>Authentication failed</h2><p>Invalid or expired OAuth flow. Please try again.</p></body></html>';
        const status = found ? 200 : 400;
        res.writeHead(status, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(html) });
        res.end(html);
      } catch (err) {
        logger.error('oauth_callback_failed', { provider, error: (err as Error).message });
        sendError(res, 500, 'OAuth callback processing failed');
      }
      return;
    }
```

**Step 4: Add `oauth.required` to SSE event listener**

In the event listener (around line 890, after the `credential.required` handler), add:

```typescript
        } else if (event.type === 'oauth.required' && event.data.envName) {
          sendSSENamedEvent(res, 'oauth_required', {
            envName: event.data.envName as string,
            sessionId: event.data.sessionId as string,
            authorizeUrl: event.data.authorizeUrl as string,
            requestId,
          });
        }
```

**Step 5: Run type-check and tests**

Run: `npx tsc --noEmit && npx vitest run tests/host/server.test.ts tests/host/server-credentials-sse.test.ts`
Expected: Clean compile, all tests pass

**Step 6: Commit**

```
feat: add OAuth callback route and oauth_required SSE event
```

---

### Task 5: Update `collect-skill-env.test.ts` Source Pattern Tests

**Files:**
- Modify: `tests/host/collect-skill-env.test.ts`

**Step 1: Update the source pattern test**

The first test checks source patterns in `server-completions.ts`. Update it to verify the renamed function and OAuth handling:

```typescript
test('source handles both file-based and directory-based skills', () => {
  const source = readFileSync(
    new URL('../../src/host/server-completions.ts', import.meta.url), 'utf-8',
  );
  // Must use withFileTypes to distinguish files from directories
  expect(source).toContain("readdirSync(dir, { withFileTypes: true })");
  // Must check for directory-based skills (SKILL.md inside subdirectory)
  expect(source).toContain("entry.isDirectory()");
  expect(source).toContain("SKILL.md");
  // Must handle OAuth requirements
  expect(source).toContain("requires.oauth");
  expect(source).toContain("oauth.required");
});
```

**Step 2: Run all tests**

Run: `npx vitest run tests/host/collect-skill-env.test.ts tests/host/oauth-skills.test.ts tests/host/server-credentials-sse.test.ts tests/host/server.test.ts`
Expected: All pass

**Step 3: Run full type-check**

Run: `npx tsc --noEmit`
Expected: Clean

**Step 4: Commit**

```
test: update source pattern tests for OAuth credential resolution
```

---

### Task 6: Update Journal and Lessons

**Files:**
- Modify: `.claude/journal/host/index.md`
- Modify: `.claude/journal/host/server.md` (or create entry)
- Modify: `.claude/lessons/architecture/entries.md` (if new lesson)

**Step 1: Add journal entry**

Append entry to the appropriate journal file for the OAuth skill credentials feature.

**Step 2: Commit all together**

```
feat: skill OAuth credential support (PKCE flow, auto-refresh, SSE events)
```
