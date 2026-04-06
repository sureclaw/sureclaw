# Auth Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a pluggable auth provider category with two implementations (admin-token and better-auth) to gate access to chat and admin UIs.

**Architecture:** Auth is a new provider category following AX's provider contract pattern. The host iterates configured auth providers in order; first non-null result wins. Admin-token wraps existing logic; better-auth adds Google OAuth, user accounts, sessions, and roles.

**Tech Stack:** BetterAuth, Kysely (existing), Google OAuth, `@better-auth/react` (client)

**Design doc:** `docs/plans/2026-04-05-betterauth-design.md`

---

### Task 1: Auth Provider Types

**Files:**
- Create: `src/providers/auth/types.ts`

**Step 1: Write the type definitions**

```typescript
// src/providers/auth/types.ts
import type { IncomingMessage, ServerResponse } from 'node:http';

export type AuthRole = 'admin' | 'user';

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  image?: string;
  role: AuthRole;
}

export interface AuthResult {
  authenticated: boolean;
  user?: AuthUser;
}

/**
 * Auth provider contract.
 *
 * authenticate() returns:
 * - null: "I don't handle this request, try the next provider"
 * - { authenticated: false }: "Credentials recognized but invalid"
 * - { authenticated: true, user }: "Valid, here's the user"
 */
export interface AuthProvider {
  authenticate(req: IncomingMessage): Promise<AuthResult | null>;
  handleRequest?(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  init?(): Promise<void>;
  shutdown?(): Promise<void>;
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/providers/auth/types.ts`
Expected: No errors

**Step 3: Commit**

```bash
git add src/providers/auth/types.ts
git commit -m "feat(auth): add AuthProvider contract types"
```

---

### Task 2: Admin Token Provider

**Files:**
- Create: `tests/providers/auth/admin-token.test.ts`
- Create: `src/providers/auth/admin-token.ts`

**Step 1: Write the failing tests**

```typescript
// tests/providers/auth/admin-token.test.ts
import { describe, test, expect } from 'vitest';
import { create } from '../../../src/providers/auth/admin-token.js';
import type { Config } from '../../../src/types.js';
import type { IncomingMessage } from 'node:http';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('auth/admin-token', () => {
  const config = { admin: { enabled: true, token: 'test-token-abc', port: 9090 } } as Config;

  test('returns null when no token header present', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq());
    expect(result).toBeNull();
  });

  test('authenticates valid bearer token', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer test-token-abc' }));
    expect(result).toEqual({
      authenticated: true,
      user: { id: 'admin-token', email: '', role: 'admin' },
    });
  });

  test('rejects invalid bearer token', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer wrong-token' }));
    expect(result).toEqual({ authenticated: false });
  });

  test('accepts X-Ax-Token header', async () => {
    const provider = await create(config);
    const result = await provider.authenticate(fakeReq({ 'x-ax-token': 'test-token-abc' }));
    expect(result).toEqual({
      authenticated: true,
      user: { id: 'admin-token', email: '', role: 'admin' },
    });
  });

  test('returns null when admin token not configured', async () => {
    const noTokenConfig = { admin: { enabled: true, port: 9090 } } as Config;
    const provider = await create(noTokenConfig);
    // No header → null (pass to next provider)
    expect(await provider.authenticate(fakeReq())).toBeNull();
  });

  test('rejects any token when admin token not configured', async () => {
    const noTokenConfig = { admin: { enabled: true, port: 9090 } } as Config;
    const provider = await create(noTokenConfig);
    // Has header but no config token → reject
    const result = await provider.authenticate(fakeReq({ authorization: 'Bearer anything' }));
    expect(result).toEqual({ authenticated: false });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/providers/auth/admin-token.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/providers/auth/admin-token.ts
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../../types.js';
import type { AuthProvider, AuthResult } from './types.js';

function extractToken(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  return (req.headers['x-ax-token'] as string)?.trim() || undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export async function create(config: Config): Promise<AuthProvider> {
  const token = config.admin?.token;

  return {
    async authenticate(req: IncomingMessage): Promise<AuthResult | null> {
      const provided = extractToken(req);
      if (!provided) return null; // No token header — pass to next provider

      if (!token) return { authenticated: false }; // Token presented but none configured
      if (!safeEqual(provided, token)) return { authenticated: false };

      return {
        authenticated: true,
        user: { id: 'admin-token', email: '', role: 'admin' },
      };
    },
  };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/providers/auth/admin-token.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/providers/auth/admin-token.ts tests/providers/auth/admin-token.test.ts
git commit -m "feat(auth): add admin-token auth provider"
```

---

### Task 3: Provider Map + Config Integration

**Files:**
- Modify: `src/host/provider-map.ts` (add `auth` entry)
- Modify: `src/types.ts` (add `auth` to Config and ProviderRegistry)

**Step 1: Add auth to provider map**

In `src/host/provider-map.ts`, add inside `_PROVIDER_MAP` after the `mcp` entry:

```typescript
  auth: {
    'admin-token': '../providers/auth/admin-token.js',
    'better-auth': '../providers/auth/better-auth.js',
  },
```

Add the typed export:

```typescript
export type AuthProviderName = keyof ProviderMapType['auth'];
```

**Step 2: Add auth to Config type**

In `src/types.ts`, add the import:

```typescript
import type { AuthProviderName } from './host/provider-map.js';
```

Add to `Config.providers`:

```typescript
    auth?: AuthProviderName[];
```

Add to `Config` (top level, after `admin`):

```typescript
  auth?: {
    better_auth?: {
      google?: {
        client_id: string;
        client_secret: string;
      };
      allowed_domains?: string[];
    };
  };
```

Add to `ProviderRegistry`:

```typescript
  auth?: import('./providers/auth/types.js').AuthProvider[];
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (no regressions)

**Step 5: Commit**

```bash
git add src/host/provider-map.ts src/types.ts
git commit -m "feat(auth): wire auth provider into provider-map and Config types"
```

---

### Task 4: Auth Middleware in Request Handler

**Files:**
- Create: `tests/host/auth-middleware.test.ts`
- Modify: `src/host/server-request-handlers.ts`

**Step 1: Write the failing tests**

```typescript
// tests/host/auth-middleware.test.ts
import { describe, test, expect } from 'vitest';
import type { IncomingMessage } from 'node:http';
import type { AuthProvider, AuthResult } from '../../src/providers/auth/types.js';

// Import after implementation
// import { authenticateRequest } from '../../src/host/server-request-handlers.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

function mockProvider(fn: (req: IncomingMessage) => Promise<AuthResult | null>): AuthProvider {
  return { authenticate: fn };
}

describe('authenticateRequest', () => {
  test('returns authenticated:false when no providers match', async () => {
    const { authenticateRequest } = await import('../../src/host/server-request-handlers.js');
    const provider = mockProvider(async () => null);
    const result = await authenticateRequest(fakeReq(), [provider]);
    expect(result).toEqual({ authenticated: false });
  });

  test('returns first non-null result from provider chain', async () => {
    const { authenticateRequest } = await import('../../src/host/server-request-handlers.js');
    const skip = mockProvider(async () => null);
    const match = mockProvider(async () => ({
      authenticated: true,
      user: { id: '1', email: 'a@b.com', role: 'admin' as const },
    }));
    const result = await authenticateRequest(fakeReq(), [skip, match]);
    expect(result.authenticated).toBe(true);
    expect(result.user?.email).toBe('a@b.com');
  });

  test('stops at first non-null result (does not call later providers)', async () => {
    const { authenticateRequest } = await import('../../src/host/server-request-handlers.js');
    let called = false;
    const first = mockProvider(async () => ({ authenticated: false }));
    const second = mockProvider(async () => { called = true; return null; });
    await authenticateRequest(fakeReq(), [first, second]);
    expect(called).toBe(false);
  });

  test('returns authenticated:false for empty provider list', async () => {
    const { authenticateRequest } = await import('../../src/host/server-request-handlers.js');
    const result = await authenticateRequest(fakeReq(), []);
    expect(result).toEqual({ authenticated: false });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/host/auth-middleware.test.ts`
Expected: FAIL — `authenticateRequest` is not exported

**Step 3: Add authenticateRequest to server-request-handlers.ts**

Add this exported function (near the top, after imports):

```typescript
import type { AuthProvider, AuthResult } from '../providers/auth/types.js';

export async function authenticateRequest(
  req: IncomingMessage,
  providers: AuthProvider[],
): Promise<AuthResult> {
  for (const provider of providers) {
    const result = await provider.authenticate(req);
    if (result !== null) return result;
  }
  return { authenticated: false };
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/host/auth-middleware.test.ts`
Expected: All 4 tests PASS

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/host/server-request-handlers.ts tests/host/auth-middleware.test.ts
git commit -m "feat(auth): add authenticateRequest middleware function"
```

---

### Task 5: Wire Auth Into Request Dispatch

**Files:**
- Modify: `src/host/server-request-handlers.ts` — thread auth providers through `RequestHandlerOpts` and add auth checks before `/admin/*` and `/v1/chat/completions` routes
- Modify: `src/host/server-admin.ts` — remove inline auth logic (it's now handled by the auth middleware chain)
- Modify: `src/host/server-webhook-admin.ts` — pass auth providers through

**Step 1: Add authProviders to RequestHandlerOpts**

In `src/host/server-request-handlers.ts`, add to `RequestHandlerOpts`:

```typescript
  /** Auth providers — checked in order for admin/chat routes. */
  authProviders?: AuthProvider[];
```

**Step 2: Add auth checks in createRequestHandler**

In the request handler function returned by `createRequestHandler()`, add auth gating:

- Before `/admin/api/*`: call `authenticateRequest()`, require `role === 'admin'`
- Before `/v1/chat/completions`: call `authenticateRequest()`, require any authenticated user
- `/auth/*` routes: iterate auth providers calling `handleRequest()`, delegate if any returns true
- Keep existing admin handler for `/admin/api/setup/*` (unauthenticated bootstrap)
- Keep existing localhost bypass logic

The auth providers are optional — if none configured, behavior is unchanged (no auth required).

**Step 3: Modify admin handler to accept pre-authenticated requests**

In `src/host/server-admin.ts`, when auth providers are configured at the request handler level, the admin handler's own inline auth becomes redundant. Add a flag to `AdminDeps`:

```typescript
  /** When true, auth is handled externally (by auth middleware). Skip inline token check. */
  externalAuth?: boolean;
```

When `externalAuth` is true, skip the inline token validation in `handleAdmin` and go straight to API routing.

**Step 4: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass (auth is optional — no behavior change when unconfigured)

**Step 6: Commit**

```bash
git add src/host/server-request-handlers.ts src/host/server-admin.ts src/host/server-webhook-admin.ts
git commit -m "feat(auth): wire auth providers into request dispatch"
```

---

### Task 6: Auth Provider Loading in Registry

**Files:**
- Modify: `src/host/registry.ts` — load auth providers from config
- Modify: `src/host/server-local.ts` — pass loaded auth providers to request handler
- Modify: `src/host/server-webhook-admin.ts` — thread auth through admin setup

**Step 1: Load auth providers in registry.ts**

Look at how existing providers are loaded in `src/host/registry.ts`. Add auth provider loading following the same pattern:

```typescript
// Load auth providers
const authProviders: AuthProvider[] = [];
if (config.providers.auth?.length) {
  for (const name of config.providers.auth) {
    const modulePath = resolveProviderPath('auth', name);
    const mod = await import(modulePath);
    const provider = await mod.create(config);
    if (provider.init) await provider.init();
    authProviders.push(provider);
  }
}
registry.auth = authProviders.length ? authProviders : undefined;
```

**Step 2: Pass auth to request handler in server-local.ts**

In the `createRequestHandler()` call, add:

```typescript
authProviders: providers.auth,
```

**Step 3: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors

**Step 4: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/host/registry.ts src/host/server-local.ts src/host/server-webhook-admin.ts
git commit -m "feat(auth): load auth providers from config in registry"
```

---

### Task 7: BetterAuth Provider (Server-Side)

**Files:**
- Create: `tests/providers/auth/better-auth.test.ts`
- Create: `src/providers/auth/better-auth.ts`
- Modify: `package.json` — add `better-auth` dependency

**Step 1: Install better-auth**

Run: `npm install better-auth`

**Step 2: Write the failing tests**

Focus on the provider contract — mock BetterAuth internals since we can't easily spin up Google OAuth in tests:

```typescript
// tests/providers/auth/better-auth.test.ts
import { describe, test, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Test the provider contract shape and route matching
describe('auth/better-auth', () => {
  test('create returns an AuthProvider with all methods', async () => {
    // Will implement once we have the module
  });

  test('authenticate returns null when no session cookie present', async () => {
    // No cookie → null (pass to next provider)
  });

  test('handleRequest returns true for /auth/* routes', async () => {
    // /auth/signin, /auth/callback, etc.
  });

  test('handleRequest returns false for non-auth routes', async () => {
    // /admin/api/status → false
  });

  test('first user gets admin role', async () => {
    // After first signup, user.role should be 'admin'
  });
});
```

**Step 3: Write the implementation**

```typescript
// src/providers/auth/better-auth.ts
import { betterAuth } from 'better-auth';
import { toNodeHandler } from 'better-auth/node';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Config } from '../../types.js';
import type { AuthProvider, AuthResult } from './types.js';

export async function create(config: Config): Promise<AuthProvider> {
  const authConfig = config.auth?.better_auth;
  if (!authConfig) {
    throw new Error('better-auth provider requires auth.better_auth config');
  }

  const socialProviders: Record<string, unknown> = {};
  if (authConfig.google) {
    socialProviders.google = {
      clientId: authConfig.google.client_id,
      clientSecret: authConfig.google.client_secret,
    };
  }

  const auth = betterAuth({
    database: {
      // Reuse existing DB connection string from env or config
      // BetterAuth's built-in Kysely adapter handles SQLite + PG
      url: process.env.DATABASE_URL ?? '',
      type: process.env.DATABASE_URL?.startsWith('postgres') ? 'postgres' : 'sqlite',
    },
    socialProviders,
    user: {
      additionalFields: {
        role: {
          type: 'string',
          defaultValue: 'user',
          input: false, // Users can't set their own role
        },
      },
    },
    account: {
      accountLinking: { enabled: true },
    },
  });

  const nodeHandler = toNodeHandler(auth);

  return {
    async init() {
      // BetterAuth auto-runs migrations when needed
    },

    async authenticate(req: IncomingMessage): Promise<AuthResult | null> {
      // Check for session cookie
      const cookies = req.headers.cookie;
      if (!cookies) return null;

      try {
        // Use BetterAuth's session API to validate
        const session = await auth.api.getSession({
          headers: new Headers(
            Object.entries(req.headers)
              .filter(([, v]) => v !== undefined)
              .map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : v!]),
          ),
        });

        if (!session?.user) return null;

        // Check domain restriction
        if (authConfig.allowed_domains?.length) {
          const domain = session.user.email?.split('@')[1];
          if (!domain || !authConfig.allowed_domains.includes(domain)) {
            return { authenticated: false };
          }
        }

        return {
          authenticated: true,
          user: {
            id: session.user.id,
            email: session.user.email ?? '',
            name: session.user.name ?? undefined,
            image: session.user.image ?? undefined,
            role: (session.user as Record<string, unknown>).role === 'admin' ? 'admin' : 'user',
          },
        };
      } catch {
        return null;
      }
    },

    async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const url = req.url ?? '';
      if (!url.startsWith('/api/auth/')) return false;

      await nodeHandler(req, res);
      return true;
    },

    async shutdown() {
      // No cleanup needed
    },
  };
}
```

Note: BetterAuth uses `/api/auth/*` as its default route prefix. The `toNodeHandler()` function handles all BetterAuth routes (sign-in, callback, session, sign-out).

**Step 4: Run tests**

Run: `npx vitest run tests/providers/auth/better-auth.test.ts`
Expected: Tests pass

**Step 5: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 6: Commit**

```bash
git add package.json package-lock.json src/providers/auth/better-auth.ts tests/providers/auth/better-auth.test.ts
git commit -m "feat(auth): add better-auth provider with Google OAuth"
```

---

### Task 8: First-User Admin Bootstrap

**Files:**
- Modify: `src/providers/auth/better-auth.ts` — add post-signup hook

**Step 1: Write the failing test**

Add to `tests/providers/auth/better-auth.test.ts`:

```typescript
test('first registered user is promoted to admin role', async () => {
  // Use BetterAuth's test helpers or a real SQLite DB in tmp
  // Create provider, simulate first signup, verify role === 'admin'
});

test('second registered user gets user role', async () => {
  // Simulate second signup, verify role === 'user'
});
```

**Step 2: Implement first-user bootstrap**

In the BetterAuth config, add an `after` hook on user creation:

```typescript
hooks: {
  after: [
    {
      matcher: (context) => context.path === '/sign-up/social',
      handler: async (ctx) => {
        // Count existing users; if this is user #1, set role to 'admin'
        const users = await auth.api.listUsers({ query: { limit: 2 } });
        if (users.total <= 1) {
          await auth.api.updateUser({
            body: { role: 'admin' },
            params: { userId: ctx.body.user.id },
          });
        }
      },
    },
  ],
},
```

The exact hook API depends on BetterAuth's version — adjust based on their docs. The pattern is: after first social sign-up, count users, promote to admin if sole user.

**Step 3: Run tests**

Run: `npx vitest run tests/providers/auth/better-auth.test.ts`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/providers/auth/better-auth.ts tests/providers/auth/better-auth.test.ts
git commit -m "feat(auth): first-user admin bootstrap on signup"
```

---

### Task 9: Auth Route Handling in Request Dispatch

**Files:**
- Modify: `src/host/server-request-handlers.ts` — add `/api/auth/*` route delegation

**Step 1: Add auth route handling**

In `createRequestHandler()`, add before the admin handler check:

```typescript
// Auth routes — delegate to auth provider's handleRequest
if (url.startsWith('/api/auth/') && opts.authProviders?.length) {
  for (const ap of opts.authProviders) {
    if (ap.handleRequest) {
      const handled = await ap.handleRequest(req, res);
      if (handled) return;
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 4: Commit**

```bash
git add src/host/server-request-handlers.ts
git commit -m "feat(auth): delegate /api/auth/* routes to auth providers"
```

---

### Task 10: Admin UI Auth Flow Update

**Files:**
- Modify: `ui/admin/src/lib/api.ts` — add session-based auth alongside token auth
- Modify: `ui/admin/src/App.tsx` — add login redirect when unauthenticated

**Step 1: Update api.ts to try session auth first**

The admin UI currently stores a bearer token in localStorage. Update the fetch wrapper to:
1. Always include `credentials: 'include'` (sends session cookies)
2. Fall back to bearer token from localStorage if present
3. On 401, redirect to `/api/auth/signin/google` instead of showing token prompt

**Step 2: Add login page component**

Create a simple login page that redirects to the BetterAuth Google sign-in endpoint:

```typescript
// ui/admin/src/components/LoginPage.tsx
export function LoginPage() {
  return (
    <div className="flex items-center justify-center min-h-screen">
      <button onClick={() => window.location.href = '/api/auth/signin/google'}>
        Sign in with Google
      </button>
    </div>
  );
}
```

**Step 3: Update App.tsx auth flow**

Check session on mount. If authenticated with admin role, show dashboard. If authenticated with user role, show "access denied." If unauthenticated, show login page. Keep the `?token=` URL param flow for backward compatibility.

**Step 4: Verify the admin UI builds**

Run: `cd ui/admin && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add ui/admin/
git commit -m "feat(auth): update admin UI for session-based auth"
```

---

### Task 11: Chat UI Auth Flow

**Files:**
- Modify: `ui/chat/package.json` — add `@better-auth/react`
- Create: `ui/chat/src/lib/auth.ts` — auth client
- Modify: `ui/chat/src/App.tsx` — gate chat behind auth

**Step 1: Install BetterAuth React client**

Run: `cd ui/chat && npm install @better-auth/react`

**Step 2: Create auth client**

```typescript
// ui/chat/src/lib/auth.ts
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient();
export const { useSession, signIn, signOut } = authClient;
```

**Step 3: Gate chat UI behind auth**

In App.tsx, wrap the main chat component:
1. Call `useSession()` to get current session
2. If loading, show spinner
3. If not authenticated, redirect to Google sign-in
4. If authenticated, render chat (pass `user.id` as the userId in chat requests)

**Step 4: Build chat UI**

Run: `cd ui/chat && npm run build`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add ui/chat/
git commit -m "feat(auth): gate chat UI behind BetterAuth session"
```

---

### Task 12: Config Defaults & Documentation

**Files:**
- Modify: `src/config.ts` — add default auth config
- Update: `docs/plans/2026-04-05-betterauth-design.md` — mark as implemented

**Step 1: Add config defaults**

In `src/config.ts` where default config is built, ensure:
- `providers.auth` defaults to `['admin-token']` (backward compatible — existing behavior unchanged)
- `auth.better_auth` is undefined by default (opt-in)

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/config.ts docs/plans/2026-04-05-betterauth-design.md
git commit -m "feat(auth): config defaults and documentation update"
```

---

### Task 13: Integration Test

**Files:**
- Create: `tests/integration/auth-flow.test.ts`

**Step 1: Write integration test**

Test the full auth middleware chain with both providers configured:

```typescript
// tests/integration/auth-flow.test.ts
import { describe, test, expect } from 'vitest';
import { create as createAdminToken } from '../../src/providers/auth/admin-token.js';
import { authenticateRequest } from '../../src/host/server-request-handlers.js';
import type { IncomingMessage } from 'node:http';
import type { Config } from '../../src/types.js';

function fakeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('auth integration', () => {
  test('admin-token provider works in chain', async () => {
    const config = { admin: { enabled: true, token: 'secret', port: 9090 } } as Config;
    const adminToken = await createAdminToken(config);

    // Valid token
    const result = await authenticateRequest(
      fakeReq({ authorization: 'Bearer secret' }),
      [adminToken],
    );
    expect(result.authenticated).toBe(true);
    expect(result.user?.role).toBe('admin');
  });

  test('unauthenticated request falls through all providers', async () => {
    const config = { admin: { enabled: true, token: 'secret', port: 9090 } } as Config;
    const adminToken = await createAdminToken(config);

    const result = await authenticateRequest(fakeReq(), [adminToken]);
    expect(result.authenticated).toBe(false);
  });
});
```

**Step 2: Run integration test**

Run: `npx vitest run tests/integration/auth-flow.test.ts`
Expected: All tests pass

**Step 3: Run full test suite one final time**

Run: `npx vitest run`
Expected: All tests pass, no regressions

**Step 4: Commit**

```bash
git add tests/integration/auth-flow.test.ts
git commit -m "test(auth): add integration tests for auth provider chain"
```
