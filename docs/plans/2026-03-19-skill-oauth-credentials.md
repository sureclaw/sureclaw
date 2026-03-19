# Skill OAuth Credentials

**Date:** 2026-03-19
**Status:** Design complete, ready for implementation

## Problem

Skills that integrate with third-party APIs (Linear, GitHub, Jira, etc.) often require OAuth authentication. The current credential system only supports static API keys — the user pastes a key into a modal. OAuth flows require browser-based authorization with redirects, token exchange, and automatic refresh.

## Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Client secret handling | Public clients (PKCE) by default, optional `client_secret_env` for providers that require it | Most modern APIs support PKCE; older ones need a secret |
| Callback URL | `GET /v1/oauth/callback/:provider` on host | Per-provider paths improve logging/routing; state param handles CSRF |
| Public URL | `AX_PUBLIC_URL` env var, default `http://localhost:<port>` | Works for k8s (admin sets public URL) and local dev (localhost) |
| Token refresh timing | At completion start | Simplest; fits existing credential resolution loop; tokens last 1+ hours which exceeds typical turn length |
| Credential storage | JSON-encoded string under `oauth:<name>` key | Single atomic key with refresh metadata; no schema changes to credential provider |
| SSE event | New `oauth_required` event type | Fundamentally different client behavior (link vs input); old clients safely ignore unknown events |
| OAuth vs env precedence | OAuth entries resolved first; matching env entries skipped | Backward compatible — skill can declare both for manual key fallback |

## Skill Frontmatter Schema

```yaml
---
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
          client_secret_env: LINEAR_OAUTH_CLIENT_SECRET  # optional
---
```

- `oauth` is an array — a skill may need tokens from multiple providers
- `name` is the credential key, same namespace as `requires.env`
- `client_secret_env` is optional — points to a separately stored secret in the credential provider (PKCE-only providers omit it)

### Parsed Type

```typescript
interface OAuthRequirement {
  name: string;
  authorize_url: string;
  token_url: string;
  scopes: string[];
  client_id: string;
  client_secret_env?: string;
}
```

## Stored Credential Format

Stored as a JSON string under key `oauth:<name>` in the credential provider:

```json
{
  "access_token": "lin_...",
  "refresh_token": "ref_...",
  "expires_at": 1773941000,
  "token_url": "https://linear.app/oauth/token",
  "client_id": "abc123",
  "client_secret_env": "LINEAR_OAUTH_CLIENT_SECRET",
  "scopes": ["read", "write"]
}
```

Self-contained — the host can refresh without re-reading skill files.

## Flow

### First-time authentication

```
1. processCompletion() starts
2. collectSkillCredentialRequirements() returns { env, oauth }
3. For OAuth entry "LINEAR_API_KEY":
   a. credentials.get("oauth:LINEAR_API_KEY") → null (not stored)
   b. startOAuthFlow(sessionId, oauthReq):
      - Generate PKCE verifier + challenge
      - Generate state token
      - Store pending flow in registry
      - Build authorize URL with client_id, redirect_uri, scope, state, code_challenge
   c. Emit SSE: event: oauth_required { envName, sessionId, authorizeUrl }
   d. Block via requestCredential(sessionId, "LINEAR_API_KEY") (120s timeout)
4. User clicks link → authenticates with Linear → redirected to host callback
5. GET /v1/oauth/callback/LINEAR_API_KEY?code=xxx&state=yyy
   a. Validate state against pending flow
   b. Exchange code for tokens (POST token_url with PKCE verifier)
   c. Build JSON credential blob (tokens + refresh metadata)
   d. Store via credentials.set("oauth:LINEAR_API_KEY", JSON.stringify(blob))
   e. Resolve pending credential promise with access_token
   f. Return HTML: "Authentication successful, you can close this tab."
6. processCompletion() unblocks
   a. Register access_token as MITM placeholder for LINEAR_API_KEY
   b. Continue with agent spawn
```

### Subsequent requests (token valid)

```
1. credentials.get("oauth:LINEAR_API_KEY") → JSON blob
2. Parse → check expires_at > now → token is fresh
3. Register access_token as MITM placeholder
4. Continue (no SSE event, no user interaction)
```

### Subsequent requests (token expired)

```
1. credentials.get("oauth:LINEAR_API_KEY") → JSON blob
2. Parse → check expires_at < now → token expired
3. refreshOAuthToken():
   a. Resolve client_secret from client_secret_env if present
   b. POST token_url with grant_type=refresh_token
   c. Update blob with new access_token, refresh_token, expires_at
   d. credentials.set("oauth:LINEAR_API_KEY", updated blob)
4. Register fresh access_token as MITM placeholder
5. Continue (no SSE event, no user interaction)
```

## Host Routes

### GET /v1/oauth/callback/:provider

Receives authorization code after user authenticates. The `:provider` segment matches the `name` field from the OAuth requirement (e.g., `LINEAR_API_KEY`).

- Validates `state` param against pending flow registry
- Exchanges code for tokens via POST to `token_url`
- Stores credential blob in credential provider
- Resolves the pending `requestCredential` promise
- Returns simple HTML success page

### Redirect URI Construction

```typescript
const publicUrl = process.env.AX_PUBLIC_URL ?? `http://localhost:${port}`;
const redirectUri = `${publicUrl}/v1/oauth/callback/${oauthReq.name}`;
```

## SSE Event

```
event: oauth_required
data: {"envName":"LINEAR_API_KEY","sessionId":"sess-1","authorizeUrl":"https://linear.app/oauth/authorize?client_id=abc123&redirect_uri=...&scope=read+write&state=...&code_challenge=...&code_challenge_method=S256&response_type=code"}
```

Clients render a "Connect with [provider]" link. Old clients safely ignore the unknown event type.

## New Module: src/host/oauth-skills.ts

Reuses PKCE utilities from existing `oauth.ts` and the pending/resolve pattern from `credential-prompts.ts`.

### Exports

```typescript
// Start an OAuth flow — returns the authorize URL to send to the client
startOAuthFlow(sessionId: string, req: OAuthRequirement, redirectUri: string): string

// Handle the callback — exchange code, store tokens, resolve pending promise
resolveOAuthCallback(provider: string, code: string, state: string, providers: ProviderRegistry): Promise<boolean>

// Refresh an expired token — reads/writes credential provider
refreshOAuthToken(credKey: string, providers: ProviderRegistry): Promise<string | null>

// Clean up pending flows for a session
cleanupSession(sessionId: string): void
```

## Files Changed

### New files
- `src/host/oauth-skills.ts` — PKCE flow, pending registry, token exchange, refresh
- `tests/host/oauth-skills.test.ts` — Unit tests

### Modified files
- `src/utils/skill-format-parser.ts` — Parse `requires.oauth` array
- `src/host/server-completions.ts` — OAuth-first credential resolution, refresh-at-start, `oauth_required` event
- `src/host/server.ts` — `GET /v1/oauth/callback/:provider` route, `oauth_required` SSE listener
- `tests/host/collect-skill-env.test.ts` — Updated return shape, OAuth parsing
- `tests/host/server-credentials-sse.test.ts` — `oauth_required` event format test

### Unchanged
- Credential provider interface — JSON string fits existing string API
- MITM proxy / placeholder map — `register(name, accessToken)` works as-is
- `credential-prompts.ts` — Existing `requestCredential`/`resolveCredential` reused
- `server-http.ts` — Existing `sendSSENamedEvent` works as-is

## Security Considerations

- **PKCE** prevents authorization code interception (no client secret needed for public clients)
- **State parameter** prevents CSRF on the callback endpoint
- **Refresh tokens stored encrypted** in credential provider (keychain or database — not plaintext env)
- **client_secret_env** indirection means secrets are never in skill files
- **Timeout** (120s) on pending flows prevents indefinite blocking
- **Access tokens as MITM placeholders** — never exposed to sandbox; replaced in proxy at wire level
