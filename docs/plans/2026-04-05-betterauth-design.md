# BetterAuth Integration Design

**Date:** 2026-04-05
**Status:** Draft

## Goal

Add user authentication to AX's chat and admin UIs using a pluggable auth provider pattern. BetterAuth handles user accounts, Google OAuth, sessions, and roles. The existing admin bearer token continues to work as a separate auth provider.

## Requirements

- **OAuth-only login** via Google (no email/password)
- **Two roles:** `admin` (full access) and `user` (chat only)
- **Domain-restricted registration:** Only Google accounts on allowed domains can sign up
- **First-user bootstrap:** First person to sign in becomes admin automatically
- **Admin token coexistence:** Existing bearer token auth remains as a separate provider for API/programmatic access (always grants admin role)
- **Provider contract pattern:** Auth is a new provider category, consistent with AX's architecture

## Design

### 1. Auth Provider Contract

New provider category `auth` following the existing provider contract pattern.

```typescript
// src/providers/auth/types.ts

interface AuthUser {
  id: string
  email: string
  name?: string
  image?: string
  role: 'admin' | 'user'
}

interface AuthResult {
  authenticated: boolean
  user?: AuthUser
}

interface AuthProvider {
  /** Try to authenticate an incoming request. Return null to pass to next provider. */
  authenticate(req: IncomingMessage): Promise<AuthResult | null>

  /** Optional: handle auth-related routes (e.g., /auth/*) */
  handleRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>

  /** Optional: lifecycle hooks */
  init?(): Promise<void>
  shutdown?(): Promise<void>
}
```

`authenticate()` returns:
- `null` — "I don't handle this request, try the next provider"
- `{ authenticated: false }` — "I recognized the credentials but they're invalid"
- `{ authenticated: true, user }` — "Valid, here's the user"

The host iterates configured auth providers in order. First non-null result wins.

### 2. Admin Token Provider

Wraps existing logic into the new contract. Minimal change.

```typescript
// src/providers/auth/admin-token.ts

export function create(config: Config): AuthProvider {
  const token = config.admin?.token

  return {
    async authenticate(req) {
      const bearer = extractBearerToken(req) // Authorization header or X-Ax-Token
      if (!bearer) return null  // No token presented — pass to next provider

      if (!token) return { authenticated: false }
      if (!timingSafeEqual(bearer, token)) return { authenticated: false }

      return {
        authenticated: true,
        user: { id: 'admin-token', email: '', role: 'admin' }
      }
    }
  }
}
```

Rate limiting stays in the request handler layer. Localhost dev bypass stays at the handler level.

### 3. BetterAuth Provider

```typescript
// src/providers/auth/better-auth.ts

import { betterAuth } from 'better-auth'

export function create(config: Config): AuthProvider {
  const authConfig = config.auth?.betterAuth

  const auth = betterAuth({
    database: /* reuse existing Kysely instance from DatabaseProvider */,
    socialProviders: {
      google: {
        clientId: authConfig.google.clientId,
        clientSecret: authConfig.google.clientSecret,
      }
    },
    user: {
      additionalFields: {
        role: { type: 'string', defaultValue: 'user' }
      }
    },
    advanced: {
      allowedDomains: authConfig.allowedDomains
    }
  })

  const nodeHandler = toNodeHandler(auth)

  return {
    async init() {
      // Run BetterAuth migrations on existing DB
      // First-user bootstrap: hook into post-signup to promote first user to admin
    },

    async authenticate(req) {
      // Extract session cookie from request
      // Call auth.api.getSession()
      // Return AuthResult with role from user record, or null if no session
    },

    async handleRequest(req, res) {
      // Routes matching /auth/* delegated to nodeHandler
      // Handles OAuth callbacks, sign-in/sign-out, session management
      return routeMatches('/auth/*') ? (await nodeHandler(req, res), true) : false
    }
  }
}
```

Key decisions:
- Reuses existing Kysely/DB instance — BetterAuth adds its tables alongside AX's
- `/auth/*` routes owned by BetterAuth for OAuth flow, callbacks, session endpoints
- First-user bootstrap: post-signup hook checks user count, promotes first to admin
- Domain restriction via BetterAuth's `allowedDomains` config

### 4. Request Flow

```
Request arrives
  |
  +-- /auth/*  --> delegate to BetterAuth handleRequest()
  |
  +-- /admin/* --> authenticate() chain --> require role: 'admin'
  |
  +-- /v1/chat/completions --> authenticate() chain --> require role: 'user' or 'admin'
  |
  +-- / (chat UI static) --> serve files (unauthenticated)
  |                       --> API calls from chat UI require auth
  |
  +-- /webhooks/* --> existing webhook auth (unchanged)
```

Auth chain in server-request-handlers.ts:

```typescript
async function authenticateRequest(
  req: IncomingMessage,
  providers: AuthProvider[]
): Promise<AuthResult> {
  for (const provider of providers) {
    const result = await provider.authenticate(req)
    if (result !== null) return result
  }
  return { authenticated: false }
}
```

### 5. UI Changes

**Chat UI:**
- Add `@better-auth/react` client
- On load, check session — if not authenticated, redirect to Google OAuth
- After auth, session cookie included on all API requests

**Admin UI:**
- Replace bearer-token localStorage flow with session-based auth
- Add login page
- Keep `?token=` URL param working (hits admin-token provider)

### 6. Config Shape

```yaml
auth:
  providers:
    - type: admin-token    # existing, always available
    - type: better-auth
      google:
        client_id: "..."
        client_secret: "..."
      allowed_domains:
        - yourcompany.com
```

### 7. Database Changes

BetterAuth auto-creates 4 tables on the existing database (SQLite or PostgreSQL):
- `user` — profiles (name, email, verification status, timestamps)
- `session` — active sessions with expiration and device info
- `account` — OAuth provider links with tokens
- `verification` — temporary verification requests

Additional `role` column on `user` table via BetterAuth's `additionalFields`.

No new database infrastructure required.

## Implementation Scope

### New Files
- `src/providers/auth/types.ts` — AuthProvider contract
- `src/providers/auth/admin-token.ts` — Existing logic reshaped
- `src/providers/auth/better-auth.ts` — BetterAuth wrapper
- `src/providers/auth/index.ts` — Provider loading
- `tests/providers/auth/` — Tests for both providers

### Modified Files
- `src/host/provider-map.ts` — Add `auth` to static allowlist
- `src/host/server-request-handlers.ts` — Add authenticateRequest() before route dispatch
- `src/host/server-admin.ts` — Remove inline auth logic, delegate to auth provider chain
- `src/host/server-chat-ui.ts` — Gate API routes behind auth
- `src/types.ts` — Add `auth` to Config type and ProviderRegistry
- `ui/chat/` — Add @better-auth/react, login flow, session handling
- `ui/admin/` — Replace token auth with session-based, keep token fallback
- `package.json` — Add `better-auth` dependency

### Unchanged
IPC, agent sandbox, runners, LLM providers, storage providers, webhooks.
