# Agent/User-Scoped Credential Storage

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Scope credential storage per agent and user so that two users providing different values for the same `envName` don't clobber each other. Skills are per-agent or per-user, so credentials should never be stored at global scope. Also make the `credential_request` IPC handler return `{ ok: true, available: false }` when the credential is missing, so the agent knows to tell the user to provide it.

**Architecture:** Add an optional `scope` parameter to the `CredentialProvider` interface. Credential lookup order: `user:<agentName>:<userId>` → `agent:<agentName>` → `process.env`. No global scope. The database provider uses the existing `scope` column (no migration needed). The `/v1/credentials/provide` endpoint accepts `agentName` (required) and optional `userId`. The `credential_request` IPC handler checks availability and returns status.

**Tech Stack:** TypeScript, Kysely (database provider), vitest, existing IPC/SSE infrastructure.

**Scope values:**
- `agent:<agentName>` — shared credential for all users of this agent (e.g., `agent:main`)
- `user:<agentName>:<userId>` — credential specific to one user of this agent (e.g., `user:main:alice`)

---

## Task 1: Add `scope` Parameter to CredentialProvider Interface

**Files:**
- Modify: `src/providers/credentials/types.ts`

**Step 1: Update the interface**

Add an optional `scope` parameter to `get`, `set`, `delete`, and `list`. When scope is omitted, implementations use a default (kept as `'global'` for backward compat with existing callers like onboarding/OAuth that aren't agent-scoped yet).

```typescript
// src/providers/credentials/types.ts — Credential provider types

export interface CredentialProvider {
  get(service: string, scope?: string): Promise<string | null>;
  set(service: string, value: string, scope?: string): Promise<void>;
  delete(service: string, scope?: string): Promise<void>;
  list(scope?: string): Promise<string[]>;
}
```

**Step 2: Verify existing tests still pass**

Run: `npm test -- --run tests/providers/credentials/`
Expected: PASS — all existing callers pass no scope, which defaults to `undefined`, and the implementations still use `'global'` when scope is not provided.

**Step 3: Commit**

```bash
git add src/providers/credentials/types.ts
git commit -m "feat: add optional scope parameter to CredentialProvider interface"
```

---

## Task 2: Update Database Provider to Use Scope Parameter

**Files:**
- Modify: `src/providers/credentials/database.ts`
- Test: `tests/providers/credentials/database.test.ts`

**Step 1: Write the failing test**

Add to `tests/providers/credentials/database.test.ts`. Add `'KEY_C'` to the `ENV_KEYS` array.

```typescript
test('scoped set and get are isolated from each other', async () => {
  await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
  await provider.set('MY_API_KEY', 'user-a-value', 'user:main:alice');

  expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
  expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBe('user-a-value');
  expect(await provider.get('MY_API_KEY', 'user:main:bob')).toBeNull();
});

test('scoped list only returns keys for that scope', async () => {
  await provider.set('KEY_A', 'a', 'agent:main');
  await provider.set('KEY_B', 'b', 'user:main:alice');
  await provider.set('KEY_C', 'c', 'user:main:alice');

  const agentKeys = await provider.list('agent:main');
  const aliceKeys = await provider.list('user:main:alice');

  expect(agentKeys).toContain('KEY_A');
  expect(agentKeys).not.toContain('KEY_B');
  expect(aliceKeys).toContain('KEY_B');
  expect(aliceKeys).toContain('KEY_C');
  expect(aliceKeys).not.toContain('KEY_A');
});

test('scoped delete does not affect other scopes', async () => {
  await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
  await provider.set('MY_API_KEY', 'user-value', 'user:main:alice');

  await provider.delete('MY_API_KEY', 'user:main:alice');

  expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
  expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBeNull();
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/providers/credentials/database.test.ts`
Expected: FAIL — scope parameter is ignored, so scoped set/get hits the default global scope.

**Step 3: Update database.ts to use scope parameter**

Replace the hardcoded `scope` usage with the parameter. Remove the closure-captured `const scope = DEFAULT_SCOPE;` line.

```typescript
const DEFAULT_SCOPE = 'global';

// In the returned object:
async get(service: string, scope?: string): Promise<string | null> {
  const effectiveScope = scope ?? DEFAULT_SCOPE;
  const row = await db.selectFrom('credential_store')
    .select('value')
    .where('scope', '=', effectiveScope)
    .where('env_name', '=', service)
    .executeTakeFirst();

  if (row) return row.value as string;

  // Only fall back to process.env for default (unscoped) calls
  if (!scope) {
    return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
  }
  return null;
},

async set(service: string, value: string, scope?: string): Promise<void> {
  const effectiveScope = scope ?? DEFAULT_SCOPE;
  const now = new Date().toISOString();
  await db.insertInto('credential_store')
    .values({
      scope: effectiveScope,
      env_name: service,
      value,
      created_at: now,
      updated_at: now,
    })
    .onConflict(oc =>
      oc.columns(['scope', 'env_name']).doUpdateSet({
        value,
        updated_at: now,
      })
    )
    .execute();

  // Only update process.env for default (unscoped) calls
  if (!scope) {
    process.env[service] = value;
  }
},

async delete(service: string, scope?: string): Promise<void> {
  const effectiveScope = scope ?? DEFAULT_SCOPE;
  await db.deleteFrom('credential_store')
    .where('scope', '=', effectiveScope)
    .where('env_name', '=', service)
    .execute();
  if (!scope) {
    delete process.env[service];
  }
},

async list(scope?: string): Promise<string[]> {
  const effectiveScope = scope ?? DEFAULT_SCOPE;
  const rows = await db.selectFrom('credential_store')
    .select('env_name')
    .where('scope', '=', effectiveScope)
    .execute();
  return rows.map(r => r.env_name as string);
},
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/credentials/database.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/credentials/database.ts tests/providers/credentials/database.test.ts
git commit -m "feat: database credential provider supports scoped storage"
```

---

## Task 3: Update Plaintext Provider to Use Scope Parameter

**Files:**
- Modify: `src/providers/credentials/plaintext.ts`
- Test: `tests/providers/credentials/plaintext.test.ts`

**Step 1: Write the failing test**

Add to `tests/providers/credentials/plaintext.test.ts`:

```typescript
test('scoped set and get are isolated from each other', async () => {
  await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
  await provider.set('MY_API_KEY', 'user-a-value', 'user:main:alice');

  expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
  expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBe('user-a-value');
  expect(await provider.get('MY_API_KEY', 'user:main:bob')).toBeNull();
});

test('scoped delete does not affect other scopes', async () => {
  await provider.set('MY_API_KEY', 'agent-value', 'agent:main');
  await provider.set('MY_API_KEY', 'user-value', 'user:main:alice');

  await provider.delete('MY_API_KEY', 'user:main:alice');

  expect(await provider.get('MY_API_KEY', 'agent:main')).toBe('agent-value');
  expect(await provider.get('MY_API_KEY', 'user:main:alice')).toBeNull();
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/providers/credentials/plaintext.test.ts`
Expected: FAIL

**Step 3: Update plaintext.ts**

Use namespaced YAML keys for scoped credentials. The YAML file stays flat — scoped keys are stored as `scope::env_name` (e.g., `agent:main::LINEAR_API_KEY`).

```typescript
function scopedKey(service: string, scope?: string): string {
  if (!scope) return service;
  return `${scope}::${service}`;
}

// In the returned object:
async get(service: string, scope?: string): Promise<string | null> {
  const store = loadStore();
  const key = scopedKey(service, scope);
  if (store[key] !== undefined) return store[key];
  // Only fall back to process.env for default (unscoped) calls
  if (!scope) {
    return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
  }
  return null;
},

async set(service: string, value: string, scope?: string): Promise<void> {
  const store = loadStore();
  const key = scopedKey(service, scope);
  store[key] = value;
  saveStore(store);
  if (!scope) {
    process.env[service] = value;
  }
},

async delete(service: string, scope?: string): Promise<void> {
  const store = loadStore();
  const key = scopedKey(service, scope);
  delete store[key];
  saveStore(store);
  if (!scope) {
    delete process.env[service];
  }
},

async list(scope?: string): Promise<string[]> {
  const store = loadStore();
  if (!scope) {
    // Return only non-scoped keys (backward compat)
    return Object.keys(store).filter(k => !k.includes('::'));
  }
  const prefix = `${scope}::`;
  return Object.keys(store)
    .filter(k => k.startsWith(prefix))
    .map(k => k.slice(prefix.length));
},
```

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/credentials/plaintext.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/providers/credentials/plaintext.ts tests/providers/credentials/plaintext.test.ts
git commit -m "feat: plaintext credential provider supports scoped storage"
```

---

## Task 4: Update Keychain Provider to Use Scope Parameter

**Files:**
- Modify: `src/providers/credentials/keychain.ts`

**Step 1: Update keychain.ts**

The keychain provider uses `account` for the env name. For scoped credentials, prepend the scope to the account name (e.g., `agent:main::LINEAR_API_KEY`).

```typescript
function scopedAccount(service: string, scope?: string): string {
  if (!scope) return service;
  return `${scope}::${service}`;
}

// In the returned object:
async get(service: string, scope?: string): Promise<string | null> {
  const account = scopedAccount(service, scope);
  const value = await keytar!.getPassword(SERVICE_NAME, account);
  if (value !== null) return value;
  if (!scope) {
    return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
  }
  return null;
},

async set(service: string, value: string, scope?: string): Promise<void> {
  const account = scopedAccount(service, scope);
  await keytar!.setPassword(SERVICE_NAME, account, value);
},

async delete(service: string, scope?: string): Promise<void> {
  const account = scopedAccount(service, scope);
  await keytar!.deletePassword(SERVICE_NAME, account);
},

async list(scope?: string): Promise<string[]> {
  const creds = await keytar!.findCredentials(SERVICE_NAME);
  if (!scope) {
    return creds.filter(c => !c.account.includes('::')).map(c => c.account);
  }
  const prefix = `${scope}::`;
  return creds
    .filter(c => c.account.startsWith(prefix))
    .map(c => c.account.slice(prefix.length));
},
```

**Step 2: Run all credential tests**

Run: `npm test -- --run tests/providers/credentials/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/credentials/keychain.ts
git commit -m "feat: keychain credential provider supports scoped storage"
```

---

## Task 5: Add Scoped Credential Lookup Helper

**Files:**
- Create: `src/host/credential-scopes.ts`
- Test: `tests/host/credential-scopes.test.ts`

Extract the lookup-with-fallback logic into a small helper so both the pre-agent and post-agent paths (and the IPC handler) use the same resolution order.

**Step 1: Write the failing test**

```typescript
// tests/host/credential-scopes.test.ts
import { describe, test, expect } from 'vitest';
import { resolveCredential, credentialScope } from '../../src/host/credential-scopes.js';
import type { CredentialProvider } from '../../src/providers/credentials/types.js';

function mockProvider(store: Record<string, Record<string, string>>): CredentialProvider {
  return {
    get: async (service: string, scope?: string) => store[scope ?? 'global']?.[service] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
}

describe('credentialScope', () => {
  test('returns user scope when both agentName and userId provided', () => {
    expect(credentialScope('main', 'alice')).toBe('user:main:alice');
  });

  test('returns agent scope when only agentName provided', () => {
    expect(credentialScope('main')).toBe('agent:main');
  });
});

describe('resolveCredential', () => {
  test('user scope overrides agent scope when both exist', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
      'user:main:alice': { KEY: 'user-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('user-val');
  });

  test('user scope overrides agent scope for sandbox env injection', async () => {
    // Simulates the credential injection flow: resolveCredential is called
    // to get the value that gets passed to credentialMap.register().
    // When both user and agent scopes exist, user scope MUST win.
    const provider = mockProvider({
      'agent:main': { LINEAR_API_KEY: 'shared-org-key' },
      'user:main:alice': { LINEAR_API_KEY: 'alice-personal-key' },
      'user:main:bob': { LINEAR_API_KEY: 'bob-personal-key' },
    });

    const aliceVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main', 'alice');
    const bobVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main', 'bob');
    const noUserVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main');

    expect(aliceVal).toBe('alice-personal-key');
    expect(bobVal).toBe('bob-personal-key');
    expect(noUserVal).toBe('shared-org-key');
  });

  test('falls back to agent scope when user scope is missing', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('agent-val');
  });

  test('returns null when neither scope has the credential', async () => {
    const provider = mockProvider({});
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBeNull();
  });

  test('tries agent scope only when no userId', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main');
    expect(val).toBe('agent-val');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/credential-scopes.test.ts`
Expected: FAIL — module not found

**Step 3: Write the implementation**

```typescript
// src/host/credential-scopes.ts
//
// Scoped credential resolution. Credentials are never global — they belong
// to an agent (shared across users) or a specific user of that agent.
//
// Lookup order: user:<agentName>:<userId> → agent:<agentName> → process.env

import type { CredentialProvider } from '../providers/credentials/types.js';

/** Build the user-scoped credential scope key. */
export function credentialScope(agentName: string, userId?: string): string {
  if (userId) return `user:${agentName}:${userId}`;
  return `agent:${agentName}`;
}

/**
 * Resolve a credential by trying user scope first, then agent scope.
 * Returns null if not found in either scope (process.env fallback is
 * handled by the provider's unscoped get, which callers can try separately
 * if needed).
 */
export async function resolveCredential(
  provider: CredentialProvider,
  envName: string,
  agentName: string,
  userId?: string,
): Promise<string | null> {
  // Try user scope first
  if (userId) {
    const userVal = await provider.get(envName, credentialScope(agentName, userId));
    if (userVal !== null) return userVal;
  }

  // Fall back to agent scope
  const agentVal = await provider.get(envName, credentialScope(agentName));
  if (agentVal !== null) return agentVal;

  return null;
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/credential-scopes.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/credential-scopes.ts tests/host/credential-scopes.test.ts
git commit -m "feat: add scoped credential resolution helper"
```

---

## Task 6: Thread agentName/userId Through Credential Lookup in server-completions.ts

**Files:**
- Modify: `src/host/server-completions.ts`

Use `resolveCredential()` from the new helper. `agentName` is already available at line 394 (`config.agent_name ?? 'main'`). `userId` is the `currentUserId` variable (derived from the `userId` parameter).

**Critical invariant:** `resolveCredential()` tries user scope first, then agent scope. This means when both `user:main:alice` and `agent:main` have a value for the same `envName`, the user-scoped value is what gets registered in `credentialMap` and injected into the sandbox. This ensures Alice's personal API key overrides the shared org key in her sandbox.

**Step 1: Add import**

At the top of `server-completions.ts`, add:

```typescript
import { resolveCredential, credentialScope } from './credential-scopes.js';
```

**Step 2: Update pre-agent credential lookup (around line 808-829)**

Replace the `providers.credentials.get(envName)` call:

```typescript
// --- Plain env credentials: prompt for any not handled by OAuth ---
for (const envName of skillEnvRequirements) {
  if (oauthHandledNames.has(envName)) continue;

  const realValue = await resolveCredential(providers.credentials, envName, agentName, currentUserId);

  if (!realValue) {
    reqLogger.info('credential_prompt_emitting', { envName });
    eventBus?.emit({
      type: 'credential.required',
      requestId,
      timestamp: Date.now(),
      data: { envName, sessionId, agentName, userId: currentUserId },
    });
    missingCredentials.push(envName);
  }

  if (realValue) {
    credentialMap.register(envName, realValue);
    reqLogger.debug('credential_placeholder_registered', { envName });
  }
}
```

**Step 3: Update post-agent credential lookup (around line 1229-1253)**

Same pattern:

```typescript
for (const envName of newRequirements) {
  if (credentialMap.toEnvMap()[envName]) continue; // Already registered

  const realValue = await resolveCredential(providers.credentials, envName, agentName, currentUserId);

  if (!realValue) {
    reqLogger.info('post_agent_credential_prompt', { envName });
    eventBus.emit({
      type: 'credential.required',
      requestId,
      timestamp: Date.now(),
      data: { envName, sessionId, agentName, userId: currentUserId },
    });
    postAgentMissing.push(envName);
  }

  if (realValue) {
    credentialMap.register(envName, realValue);
    collectedEnvNames.push(envName);
    reqLogger.debug('post_agent_credential_registered', { envName });
  }
}
```

**Step 4: Update OAuth credential lookup (around line 776-806)**

The OAuth credential lookup also uses `providers.credentials.get(credKey)`. Update it to use scoped lookup:

```typescript
const credKey = `oauth:${oauthReq.name}`;
const stored = await resolveCredential(providers.credentials, credKey, agentName, currentUserId);
```

And the `refreshOAuthToken` call that reads/writes credentials — it takes the credential provider directly, so we need to pass the scope there too. Check the `refreshOAuthToken` signature and update if needed (may be a separate task or handled inline).

**Step 5: Run build**

Run: `npm run build`
Expected: PASS — no type errors.

**Step 6: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "feat: credential lookup uses agent/user scope instead of global"
```

---

## Task 7: Update HTTP Endpoints to Accept agentName and userId

**Files:**
- Modify: `src/host/server-request-handlers.ts` (line 543-559)
- Modify: `src/host/server-admin.ts` (line 391-406)

**Step 1: Update `/v1/credentials/provide` in server-request-handlers.ts**

Accept `agentName` (required) and optional `userId`. Store at user scope if userId provided, always also store at agent scope.

```typescript
// Credential provide
if (url === '/v1/credentials/provide' && req.method === 'POST') {
  try {
    const body = JSON.parse(await readBody(req));
    const { envName, value, agentName, userId } = body;
    if (typeof envName !== 'string' || !envName || typeof value !== 'string') {
      sendError(res, 400, 'Missing required fields: envName, value');
      return;
    }
    const { credentialScope } = await import('./credential-scopes.js');
    // Store user-scoped if userId provided
    if (userId && typeof userId === 'string' && agentName && typeof agentName === 'string') {
      await providers.credentials.set(envName, value, credentialScope(agentName, userId));
    }
    // Always store at agent scope
    if (agentName && typeof agentName === 'string') {
      await providers.credentials.set(envName, value, credentialScope(agentName));
    } else {
      // Backward compat: no agentName → store unscoped (global)
      await providers.credentials.set(envName, value);
    }
    const responseBody = JSON.stringify({ ok: true });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(responseBody)) });
    res.end(responseBody);
  } catch (err) {
    sendError(res, 400, `Invalid request: ${(err as Error).message}`);
  }
  return;
}
```

**Step 2: Update `/admin/api/credentials/provide` in server-admin.ts**

Same pattern:

```typescript
if (pathname === '/admin/api/credentials/provide' && method === 'POST') {
  try {
    const body = JSON.parse(await readBody(req));
    const { envName, value, agentName, userId } = body;
    if (typeof envName !== 'string' || !envName || typeof value !== 'string') {
      sendError(res, 400, 'Missing required fields: envName, value');
      return;
    }
    const { credentialScope } = await import('./credential-scopes.js');
    if (userId && typeof userId === 'string' && agentName && typeof agentName === 'string') {
      await deps.providers.credentials.set(envName, value, credentialScope(agentName, userId));
    }
    if (agentName && typeof agentName === 'string') {
      await deps.providers.credentials.set(envName, value, credentialScope(agentName));
    } else {
      await deps.providers.credentials.set(envName, value);
    }
    sendJSON(res, { ok: true });
  } catch (err) {
    sendError(res, 400, `Invalid request: ${(err as Error).message}`);
  }
  return;
}
```

**Step 3: Run build**

Run: `npm run build`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server-request-handlers.ts src/host/server-admin.ts
git commit -m "feat: credential provide endpoints accept agentName/userId for scoped storage"
```

---

## Task 8: Include agentName/userId in SSE credential_required Event

**Files:**
- Modify: `src/host/server-request-handlers.ts` (line 190-195)

The SSE event should include `agentName` and `userId` so the client can send them back when providing the credential.

**Step 1: Update the SSE event emission**

```typescript
} else if (event.type === 'credential.required' && event.data.envName) {
  sendSSENamedEvent(res, 'credential_required', {
    envName: event.data.envName as string,
    sessionId: event.data.sessionId as string,
    agentName: (event.data.agentName as string) ?? undefined,
    userId: (event.data.userId as string) ?? undefined,
    requestId,
  });
}
```

**Step 2: Run build**

Run: `npm run build`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/server-request-handlers.ts
git commit -m "feat: include agentName/userId in credential_required SSE event"
```

---

## Task 9: Make credential_request IPC Handler Return Availability Status

**Files:**
- Modify: `src/host/ipc-handlers/skills.ts`
- Create: `tests/host/ipc-handlers/skills-credential.test.ts`

When the agent calls `credential_request`, the handler checks whether the credential is already available and returns `{ ok: true, available: boolean }`. This way, if another session hits the same requirement while waiting on the user, the agent knows it's not available yet and can tell the user.

**Step 1: Write the failing test**

```typescript
// tests/host/ipc-handlers/skills-credential.test.ts
import { describe, test, expect } from 'vitest';
import { createSkillsHandlers } from '../../../src/host/ipc-handlers/skills.js';
import type { ProviderRegistry } from '../../../src/types.js';

function mockProviders(credentialStore: Record<string, Record<string, string>> = {}): ProviderRegistry {
  return {
    audit: { log: async () => {}, query: async () => [] },
    credentials: {
      get: async (service: string, scope?: string) => credentialStore[scope ?? 'global']?.[service] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    },
  } as unknown as ProviderRegistry;
}

const ctx = { sessionId: 'test-session', userId: 'test-user', agentId: 'main' } as any;

describe('credential_request handler', () => {
  test('returns available: false when credential is missing', async () => {
    const handlers = createSkillsHandlers(mockProviders());
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
  });

  test('returns available: true when credential exists at agent scope', async () => {
    const handlers = createSkillsHandlers(mockProviders({
      'agent:main': { LINEAR_API_KEY: 'sk-123' },
    }));
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
  });

  test('returns available: true when credential exists at user scope', async () => {
    const handlers = createSkillsHandlers(mockProviders({
      'user:main:test-user': { LINEAR_API_KEY: 'sk-456' },
    }));
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
  });

  test('records requested credential in the map', async () => {
    const requested = new Map<string, Set<string>>();
    const handlers = createSkillsHandlers(mockProviders(), { requestedCredentials: requested });
    await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(requested.get('test-session')?.has('LINEAR_API_KEY')).toBe(true);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/host/ipc-handlers/skills-credential.test.ts`
Expected: FAIL — handler currently returns `{ ok: true }` without `available` field.

**Step 3: Update the credential_request handler**

Modify `src/host/ipc-handlers/skills.ts`:

```typescript
import { resolveCredential } from '../credential-scopes.js';

// In the handler:
credential_request: async (req: any, ctx: IPCContext) => {
  const { envName } = req;
  if (opts?.requestedCredentials) {
    let envNames = opts.requestedCredentials.get(ctx.sessionId);
    if (!envNames) {
      envNames = new Set();
      opts.requestedCredentials.set(ctx.sessionId, envNames);
    }
    envNames.add(envName);
  }

  // Check if credential is already available (user scope → agent scope)
  const agentName = ctx.agentId ?? 'main';
  const available = (await resolveCredential(providers.credentials, envName, agentName, ctx.userId)) !== null;

  logger.info('credential_request_recorded', { envName, sessionId: ctx.sessionId, available });
  await providers.audit.log({
    action: 'credential_request',
    sessionId: ctx.sessionId,
    args: { envName, available },
  });
  return { ok: true, available };
},
```

Note: Verify that `ctx.agentId` and `ctx.userId` are available on `IPCContext`. The `agentId` is typically set from the completion handler context. If not present, check `ipc-server.ts` for the `IPCContext` type and thread it through from `server-completions.ts` where IPC handlers are registered.

**Step 4: Run tests to verify they pass**

Run: `npm test -- --run tests/host/ipc-handlers/skills-credential.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `npm test -- --run tests/`
Expected: PASS

**Step 6: Commit**

```bash
git add src/host/ipc-handlers/skills.ts tests/host/ipc-handlers/skills-credential.test.ts
git commit -m "feat: credential_request IPC returns availability status with scoped lookup"
```

---

## Task 10: Update Skills Documentation

**Files:**
- Modify: `.claude/skills/ax-provider-credentials/SKILL.md`

**Step 1: Update the skill doc**

Key updates:
- Interface methods now have optional `scope?: string` parameter
- Credential scope values: `agent:<agentName>`, `user:<agentName>:<userId>`
- Credential lookup order: `user:<agentName>:<userId>` → `agent:<agentName>` → `process.env` (unscoped only)
- Helper: `resolveCredential()` and `credentialScope()` in `src/host/credential-scopes.ts`
- `/v1/credentials/provide` accepts `agentName` and optional `userId`
- `credential_required` SSE event includes `agentName` and `userId`
- `credential_request` IPC returns `{ ok: true, available: boolean }`
- `credential_store.scope` is no longer hardcoded to `'global'` — uses `agent:*` and `user:*:*` scopes

**Step 2: Commit**

```bash
git add .claude/skills/ax-provider-credentials/SKILL.md
git commit -m "docs: update credential provider skill for agent/user-scoped storage"
```

---

## Summary

| Task | What | Key Files |
|------|------|-----------|
| 1 | Add `scope` to CredentialProvider interface | `types.ts` |
| 2 | Database provider uses scope parameter | `database.ts`, test |
| 3 | Plaintext provider uses scope parameter | `plaintext.ts`, test |
| 4 | Keychain provider uses scope parameter | `keychain.ts` |
| 5 | Scoped credential resolution helper | `credential-scopes.ts`, test |
| 6 | Thread agentName/userId through lookups | `server-completions.ts` |
| 7 | HTTP endpoints accept agentName/userId | `server-request-handlers.ts`, `server-admin.ts` |
| 8 | Include agentName/userId in SSE event | `server-request-handlers.ts` |
| 9 | credential_request returns availability | `ipc-handlers/skills.ts`, test |
| 10 | Update documentation | `SKILL.md` |

**Dependencies:** Tasks 2-4 depend on Task 1. Task 5 is independent. Tasks 6-8 depend on Task 5. Task 9 depends on Task 5. Task 10 depends on all others.

**Scope values:**
- `agent:<agentName>` — shared credential for all users of this agent
- `user:<agentName>:<userId>` — credential specific to one user of this agent

**Lookup order:** `user:<agentName>:<userId>` → `agent:<agentName>` → (process.env for unscoped calls only)

**No migration needed:** The `credential_store` table already has a `scope` column with a unique index on `(scope, env_name)`.

**Backward compatible:** Existing unscoped callers (onboarding, OAuth token refresh, etc.) still work — they hit the default `'global'` scope. The skill credential paths now use agent/user scopes exclusively.

**What this does NOT change:**
- No blocking credential prompts (stays non-blocking fire-and-forget)
- No cross-replica coordination needed
- No new database migrations
- No changes to sandbox credential injection (CredentialPlaceholderMap is already per-session)
