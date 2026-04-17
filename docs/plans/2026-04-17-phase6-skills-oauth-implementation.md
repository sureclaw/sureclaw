# Phase 6 — OAuth PKCE Flow (+ Admin-Registered Provider Fallback) — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Phase 5 cards with `authType: oauth` get a working "Connect with &lt;provider&gt;" button. Clicking it runs a PKCE flow through AX's existing OAuth infrastructure, writes the resulting access token to the declared credential scope, and re-triggers reconcile so the skill can transition to `enabled`. Admin-registered providers (with pre-configured `client_id`/`client_secret`) override the frontmatter's public `client_id` — invisible to the end user, and the escape hatch for providers that don't support PKCE (e.g. Google's confidential web flow).

**Scope:** OAuth authorization-code + PKCE (S256). No implicit flow, no device flow. Admin-registered providers stored in a new `admin_oauth_providers` SQLite table with the client_secret encrypted at rest. Refresh-token path is **deferred** — we store the refresh blob but do not yet refresh automatically.

**Architecture:**
- **Reuse** `src/host/oauth.ts`'s `generateCodeVerifier` / `generateCodeChallenge` / `generateState` primitives.
- **Parallel-but-separate** pending-flow map to `oauth-skills.ts`'s (whose map is session-scoped for agent-initiated flows). Admin-initiated flows live in a new `admin-oauth-flow.ts` module keyed by `{agentId, skillName, envName}`.
- **One callback**, two resolvers. The existing `/v1/oauth/callback/:provider` handler first asks the admin module whether the `state` matches one of its pending flows; if not, it falls back to the agent-side `resolveOAuthCallback`. This keeps the single callback URL simple and means we don't need to register two separate redirect URIs at OAuth providers.
- **Admin-registered provider override** stored in SQLite with AES-256-GCM. Key material sourced from `AX_OAUTH_SECRET_KEY` env var, or derived from `config.admin.token` as a fallback (with a loud warning when no dedicated key is set).

---

## Architecture constraints (read once, apply everywhere)

- **PKCE always.** Every flow sends `code_challenge` + `code_verifier`. Admin-registered providers additionally send `client_secret`. Public-client PKCE without a secret must also work (frontmatter-only path).
- **State is unguessable + time-bounded + single-use.** 15-minute TTL; removed from the map on callback (success or failure).
- **No credential values in logs, URLs, audit args, SSE.** Access tokens + refresh tokens never appear in audit entries. Client secrets never appear anywhere outside the encrypted DB column.
- **Scope correctness.** When a SetupCard credential is `scope: 'user'`, the access token lands at `credentialScope(agentName, userId)`. Admin user is resolved from the request body (optional `userId`) → `config.default_user_id` → `'admin'` literal, same chain as phase-5 approve.
- **Atomic callback writes.** Exchange code → write access_token + refresh blob → trigger reconcile. Failures surface as 500 with a minimal user-visible HTML page (existing pattern). Audit failures propagate (security invariant from phase 5).
- **TDD strictly.** Unit tests for crypto + DB + flow module. HTTP tests for all new endpoints. Playwright for the new UI.

---

## Task 1 — Admin OAuth providers table + crypto + storage module

**Files:**
- Create: `src/host/admin-oauth-providers.ts` (storage module + crypto helpers)
- Create: `tests/host/admin-oauth-providers.test.ts`
- Modify: `src/host/skills/migrations.ts` (or wherever skills-related migrations live) — add new `admin_oauth_providers` migration. If migrations live elsewhere (check `src/providers/database/migrations.ts`), add there.

**Schema (both SQLite + Postgres):**
```sql
CREATE TABLE admin_oauth_providers (
  provider TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  client_secret_enc TEXT,  -- base64(iv || ciphertext || tag), nullable for public-client admin configs
  redirect_uri TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**Crypto:**
- AES-256-GCM. 12-byte IV. 16-byte tag. Encoded as `base64(iv || ciphertext || tag)`.
- Key from `process.env.AX_OAUTH_SECRET_KEY` if set (must be 32 bytes, hex-encoded); else `crypto.createHash('sha256').update(config.admin.token).digest()` with a startup `logger.warn('oauth_secret_key_derived_from_admin_token')`.
- Helpers in the same module: `encryptSecret(plain, key): string`, `decryptSecret(blob, key): string`. Pure functions, unit-tested.

**Module API:**
```ts
export interface AdminOAuthProvider {
  provider: string;
  clientId: string;
  clientSecret?: string;  // decrypted at read time; absent when not stored
  redirectUri: string;
  updatedAt: string;
}

export interface AdminOAuthProviderStore {
  get(provider: string): Promise<AdminOAuthProvider | null>;
  list(): Promise<Array<Omit<AdminOAuthProvider, 'clientSecret'>>>;  // list NEVER includes secrets
  upsert(input: { provider: string; clientId: string; clientSecret?: string; redirectUri: string }): Promise<void>;
  delete(provider: string): Promise<boolean>;
}

export function createAdminOAuthProviderStore(db: Kysely<any>, key: Buffer): AdminOAuthProviderStore;
```

**Tests — `tests/host/admin-oauth-providers.test.ts`:**
1. `encryptSecret` then `decryptSecret` round-trips exactly.
2. Tampering with the ciphertext → decrypt throws (GCM integrity).
3. `upsert + get` returns the decrypted secret.
4. `list` NEVER includes `clientSecret` even when stored.
5. `delete` removes the row + subsequent `get` returns null.
6. Upsert with `clientSecret: undefined` stores a NULL encrypted value; `get` returns `clientSecret: undefined`.

**Commit:** `feat(oauth): admin-registered provider storage with encrypted secrets`

---

## Task 2 — Admin HTTP endpoints for OAuth provider CRUD

**Files:**
- Modify: `src/host/server-admin.ts` (new routes + `AdminDeps.adminOAuthStore?: AdminOAuthProviderStore`)
- Modify: `src/host/server-webhook-admin.ts` + `src/host/server.ts` (pass-through)
- Modify: `src/host/server-init.ts` (construct the store when DB + key available)
- Modify: `tests/host/server-admin-skills.test.ts` (extend with new describe block) OR create `tests/host/server-admin-oauth-providers.test.ts` — pick the clearer location; leaning toward a new file since this is a standalone concept.

**Routes:**
- `GET /admin/api/oauth/providers` → `{ providers: [{provider, clientId, redirectUri, updatedAt}] }` (no clientSecret)
- `POST /admin/api/oauth/providers` — body `{provider, clientId, clientSecret?, redirectUri}` (Zod strict). Upserts. Returns `{ok:true}`.
- `DELETE /admin/api/oauth/providers/:name` → `{ok:true, removed:boolean}` (idempotent).
- 503 `{error: 'OAuth providers not configured'}` when store absent.
- Audit log on each mutation (`oauth_provider_upserted` / `oauth_provider_deleted`) — include `provider` name + `hasSecret: boolean`, NEVER the secret value.

**Tests:**
1. Happy path — POST, GET lists it, GET by name returns without secret, DELETE removes it.
2. Update path — POST twice with same `provider`, second wins.
3. Validation — missing provider/clientId/redirectUri → 400.
4. Audit — upsert produces `oauth_provider_upserted` with `hasSecret: true` when secret included.
5. 503 when store missing.
6. Values never echoed — confirm `clientSecret` field not in GET response even if POSTed.

**Commit:** `feat(admin): OAuth provider CRUD endpoints`

---

## Task 3 — Admin-initiated OAuth flow module + start endpoint

**Files:**
- Create: `src/host/admin-oauth-flow.ts` (parallel to `oauth-skills.ts` for admin-initiated flows)
- Modify: `src/host/server-admin.ts` — new route + `AdminDeps` field `adminOAuthFlow?: AdminOAuthFlow`
- Modify: `src/host/server-init.ts` — construct the flow module, expose on `HostCore`
- Modify: `tests/host/server-admin-skills.test.ts` — extend or new file `tests/host/admin-oauth-flow.test.ts`

**Module:**
```ts
// src/host/admin-oauth-flow.ts

export interface AdminOAuthPendingFlow {
  agentId: string;
  agentName: string;  // for credential-scope derivation
  skillName: string;
  envName: string;
  scope: 'user' | 'agent';
  userId?: string;
  codeVerifier: string;
  redirectUri: string;
  tokenUrl: string;
  clientId: string;  // effective clientId (admin > frontmatter)
  clientSecret?: string;  // populated only for admin-registered providers
  createdAt: number;
}

export interface AdminOAuthFlow {
  /** Returns { state, authUrl }. TTL 15 min. */
  start(input: {
    agentId: string;
    agentName: string;
    skillName: string;
    envName: string;
    scope: 'user' | 'agent';
    userId?: string;
    provider: string;  // frontmatter oauth.provider
    authorizationUrl: string;
    tokenUrl: string;
    clientId: string;  // frontmatter clientId
    scopes: string[];
    redirectUri: string;
    adminProvider?: { clientId: string; clientSecret?: string; redirectUri: string };
  }): { state: string; authUrl: string };

  /** Look up and claim a pending flow. Returns undefined if not found or expired. Single-use: subsequent lookups miss. */
  claim(state: string): AdminOAuthPendingFlow | undefined;
}

export function createAdminOAuthFlow(opts?: { now?: () => number }): AdminOAuthFlow;
```

Keeps an in-memory `Map<state, AdminOAuthPendingFlow>`. Entries older than 15 minutes are swept lazily on `start` and `claim`. The `now` injection is for tests.

**Start endpoint — `POST /admin/api/skills/oauth/start`:**

Body (Zod strict):
```ts
z.object({
  agentId: z.string().min(1),
  skillName: z.string().min(1),
  envName: z.string().min(1),
  userId: z.string().optional(),
}).strict();
```

Behavior:
1. 503 when any of `skillStateStore`, `adminOAuthFlow`, `agentRegistry` missing.
2. Look up the setup queue for agentId → find card with skillName → find `missingCredentials` entry with envName AND `authType === 'oauth'`. If missing at any step, 404 `{error: 'No pending OAuth credential for this skill'}`.
3. Extract the frontmatter `oauth` block from the card's missingCredential.
4. If admin-registered provider exists for `oauth.provider`, fetch it. Its `clientId` + `clientSecret` override frontmatter's `clientId`. Use `adminProvider.redirectUri` if set, else the default `${config.server.public_url}/v1/oauth/callback/${oauth.provider}` — actually keep it simple: redirectUri is always the server's own callback `${host}/v1/oauth/callback/${oauth.provider}`, computed from request host headers (with a `config.admin.public_base_url` override if present).
5. Get agent name from `agentRegistry.get(agentId)` for credential-scope derivation.
6. Call `adminOAuthFlow.start({...})`, return `{authUrl, state}`.
7. Audit: `oauth_start`, args `{agentId, skillName, envName, provider, hasAdminProvider: boolean}`. NO tokens, NO secrets.

**Tests:**
1. Happy path (frontmatter-only) — POST `/skills/oauth/start`, asserts response has `authUrl` containing `code_challenge=*&code_challenge_method=S256&state=*&client_id=<frontmatter-clientId>`.
2. Happy path (admin-registered override) — pre-populate adminOAuthStore with provider `linear` + `clientId: admin-xxx`. POST, assert `authUrl` has `client_id=admin-xxx` (NOT the frontmatter one).
3. Non-oauth credential → 404 (the missingCredential is api_key, not oauth).
4. Skill not in queue → 404.
5. envName not in missingCredentials → 404.
6. 503 when deps missing.
7. Zod validation — missing agentId/skillName/envName → 400.
8. Audit emitted with `hasAdminProvider` correctly set; no secret leaked.

**Commit:** `feat(admin): POST /admin/api/skills/oauth/start (PKCE initiation)`

---

## Task 4 — Extend OAuth callback to handle admin flows + trigger reconcile

**Files:**
- Modify: `src/host/server-request-handlers.ts` (the existing `/v1/oauth/callback/:provider` handler around line 684)
- Modify: `src/host/admin-oauth-flow.ts` (add `resolveCallback` method that exchanges the code and writes credentials)
- Modify: `tests/host/admin-oauth-flow.test.ts` — extend

**Callback handler change:**

```ts
// server-request-handlers.ts (pseudo-diff)
if (url.startsWith('/v1/oauth/callback/') && req.method === 'GET') {
  // ... existing provider/code/state extraction ...

  // Try admin-initiated flow FIRST (it's the newer, more specific path).
  // Rationale: agent-initiated flows have lifetime tied to the session that
  // requested the credential, so they rarely overlap with admin approvals.
  // Admin-initiated flows are unambiguous from the state value alone.
  if (adminOAuthFlow) {
    const resolved = await adminOAuthFlow.resolveCallback({
      provider, code, state,
      credentials: providers.credentials,
      reconcileAgent,  // same signature as admin approve: (agentId, ref) => Promise<...>
      audit: providers.audit,
    });
    if (resolved.matched) {
      const html = resolved.ok
        ? '<html>...success...</html>'
        : '<html>...failed...</html>';
      res.writeHead(resolved.ok ? 200 : 400, {...});
      res.end(html);
      return;
    }
  }

  // Fall through to existing agent-initiated path.
  const { resolveOAuthCallback } = await import('./oauth-skills.js');
  const found = await resolveOAuthCallback(provider, code, state, providers.credentials, eventBus);
  // ... existing response ...
}
```

**`AdminOAuthFlow.resolveCallback` implementation:**

```ts
resolveCallback(opts: {
  provider: string;
  code: string;
  state: string;
  credentials: CredentialProvider;
  reconcileAgent: (agentId: string, ref: string) => Promise<{...}>;
  audit: AuditProvider;
}): Promise<{ matched: false } | { matched: true; ok: true } | { matched: true; ok: false; reason: string }>
```

Steps:
1. `claim(state)` → pending flow. If none, return `{matched: false}` (falls through to agent path).
2. Build token request:
   ```
   POST tokenUrl
   Content-Type: application/x-www-form-urlencoded
   grant_type=authorization_code
   code=<code>
   redirect_uri=<flow.redirectUri>
   client_id=<flow.clientId>
   code_verifier=<flow.codeVerifier>
   [+ client_secret=<flow.clientSecret> when admin-registered]
   ```
3. On non-200: audit `oauth_callback_failed`, return `{matched:true, ok:false, reason: 'token_exchange_failed'}`.
4. Parse JSON: `{access_token, refresh_token?, expires_in?, token_type?}`. If `access_token` missing, fail.
5. Compute scope key from `flow.scope` + `flow.agentName` + `flow.userId` (same chain as phase-5 approve).
6. `credentials.set(flow.envName, access_token, scopeKey)`.
7. If `refresh_token` present: also store a blob at `<envName>__oauth_blob` with `{access_token, refresh_token, expires_at, token_url, client_id, client_secret_env?: undefined, scopes}` so a future refresh task can use it. Keep the blob shape compatible with existing `OAuthCredentialBlob`.
8. Audit: `oauth_callback_success`, args `{agentId, skillName, envName, provider}`. NO tokens, NO secrets. Let audit throws propagate (security invariant).
9. Fire-and-forget `reconcileAgent(agentId, 'refs/heads/main')` so the SetupCard transitions — swallow its throw and log, same pattern as phase-5 approve. This is a best-effort flip; the admin can always click Approve directly later if reconcile doesn't auto-drop the card.
10. Return `{matched:true, ok:true}`.

**Security note for refresh blob:** Storing refresh tokens in the credential provider means they're plain strings in the DB (same as access_token). Refresh tokens are long-lived and high-value — if we want encryption at rest for them, that's an enhancement to the credentials provider, out of scope for phase 6. Document this in the journal.

**Tests:**
1. Happy path — seed a pending flow, mock `fetch` for the token endpoint to return `{access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600}`. Call `resolveCallback`. Assert:
   - `credentials.set(envName, 'at-123', scope)` called.
   - `credentials.set('<envName>__oauth_blob', <JSON blob>, scope)` called with access_token+refresh_token in the blob.
   - `reconcileAgent(agentId, 'refs/heads/main')` called.
   - Audit `oauth_callback_success` with no token values.
2. State not found → `{matched: false}`.
3. Token endpoint returns 400 → `{matched: true, ok: false}`; no credential writes.
4. No `refresh_token` in response → no `__oauth_blob` write (only the access_token land).
5. Admin-registered flow includes `client_secret` in the token POST body.
6. Reconcile throws → still returns `{matched:true, ok:true}` (the exchange succeeded; the reconcile throw is logged).

**Tests on the route itself** (in `tests/host/server-oauth-callback.test.ts` — new small file):
1. Admin flow wins — pre-populate admin flow with a state; hit `/v1/oauth/callback/linear?code=abc&state=...`; assert success HTML + admin flow's side effects.
2. Fall-through to agent flow — no admin flow registered for the state; callback delegates to `resolveOAuthCallback` (mock that).
3. Bad request (missing code/state) → 400 HTML.

**Commit:** `feat(oauth): admin callback stores scoped credential + triggers reconcile`

---

## Task 5 — UI: "Connect with &lt;provider&gt;" button in SetupCardView + polling

**Files:**
- Modify: `ui/admin/src/components/pages/skills-page.tsx`
- Modify: `ui/admin/src/lib/api.ts` — add `startOAuth(body)` method
- Modify: `ui/admin/src/lib/types.ts` — add response type
- Modify: `ui/admin/tests/fixtures.ts` — add a MOCK_OAUTH_SKILL with one OAuth credential
- Modify: `ui/admin/tests/skills.spec.ts` — new Playwright case(s)

**API client:**
```ts
startOAuth(body: { agentId: string; skillName: string; envName: string; userId?: string }): Promise<{ authUrl: string; state: string }> {
  return apiFetch('/skills/oauth/start', { method: 'POST', body: JSON.stringify(body) });
}
```

**UI change in `SetupCardView`:**

Replace the phase-5 "OAuth flow — coming in phase 6" disabled block. New layout for oauth credentials:

```
┌ envName (user-scoped via OAuth)  [ Connect with Linear → ]  │
│   ✓ Connected  (when present; chip appears after polling detects resolution) │
└──────────────────────────────────────────────────────────────┘
```

Button click handler:
1. Disable button, show "Opening authorization…"
2. `const { authUrl } = await api.startOAuth({...});`
3. `window.open(authUrl, '_blank', 'noopener,noreferrer')` — new tab.
4. Start a 2-second polling interval that calls `api.skillsSetup()` and checks whether the current card's `missingCredentials` still includes the envName. If it disappeared → cred connected; stop polling; show ✓ chip. If polling exceeds 5 minutes with no resolution → stop, show a retry hint. If the card itself disappears (skill transitioned to enabled), stop polling — the parent `onChange` will refresh and the card is gone anyway.
5. Cleanup: clear the interval on unmount.

**Approve button logic update:**

Current: disabled when ANY oauth credential present.
New: disabled only when any credential is NOT yet "fulfilled" — where oauth creds are fulfilled when they disappear from `missingCredentials`. Since fulfilled creds ARE already missing from the list, we just track which envNames the user has "satisfied" via `credentialValues` for api_key OR via connection for oauth. The card's `missingCredentials` array shrinks as the user provides each; the Approve button enables when the array reduces to only-OAuth-needing-connection items → no wait, the list coming from the server is fresh each poll.

Simpler model: re-fetch the setup queue on every poll tick. When a card's `missingCredentials` is either empty OR contains only api_key creds with non-empty values, the Approve button is enabled. OAuth creds that need connection keep it disabled.

Concretely: `approveDisabled = submitting || success || missingApiKeyValue || hasUnconnectedOAuth`. Where `hasUnconnectedOAuth = card.missingCredentials.some(c => c.authType === 'oauth')` — because any oauth credential still in missingCredentials is still not connected. Once connected, the reconciler's next pass removes it from missingCredentials.

**Tests:**
1. OAuth card renders "Connect with &lt;provider&gt;" button.
2. Clicking the button POSTs to `/skills/oauth/start` with the right body and opens a new tab (mock `window.open`).
3. After connection (simulate by mocking `/skills/setup` to return a card without that envName on second call), the chip flips to "Connected" and Approve becomes enabled.
4. When card has a pure-OAuth credential list and nothing has connected yet, Approve stays disabled.

**Commit:** `feat(admin-ui): Connect with <provider> button + polling`

---

## Task 6 — Local E2E verification

Same pattern as phase 5's Task 8: run a local host with SQLite, seed a setup card with an OAuth credential, call the start endpoint, and verify the authUrl shape. Skipping actual provider round-trip (no real Linear creds to burn); mock the token endpoint with a tiny local HTTP server that echoes back `{access_token, refresh_token, expires_in}`. Confirm that after hitting the callback, the credential lands in the DB at the right scope.

Journal the walkthrough.

**Commit:** `docs(oauth): phase 6 local verification walkthrough`

---

## Task 7 — Documentation

- `.claude/skills/ax-host/SKILL.md` — add OAuth flow subsection + mention `admin_oauth_providers` table and the `/admin/api/oauth/providers` CRUD + `/admin/api/skills/oauth/start`.
- `docs/plans/2026-04-16-git-native-skills-design.md` — mark phase 6 landed in Rollout Status.
- Journal wrap-up entry under `.claude/journal/host/skills.md`.
- Lessons if any emerge (PKCE pitfalls, crypto key sourcing, fallback resolution order).

**Commit:** `docs(oauth): phase 6 rollout — OAuth PKCE + admin-registered providers`

---

## Deferred from plan (explicitly out of scope)

- **Admin settings UI for provider CRUD.** Phase 6's MVP is the PKCE flow. Admin-registered providers can be POSTed via curl against the new endpoints; a UI for CRUD is tracked as phase 6.1 or future.
- **Background refresh.** The blob is stored so a future refresh task can use it. Refresh-on-read or a cron-driven refresh is tracked as phase 6.2 or future.
- **Refresh-token encryption at rest.** Tracked as a credential-provider enhancement; out of scope here.

---

## Execution note

We're in `.worktrees/skills-phase6`, branched off `feat/skills-phase5-dashboard` (PR #180). Phase 6 cannot merge to `main` until phase 5 does; if phase 5 needs changes during review, we rebase phase 6 on the new phase-5 HEAD. TDD strictly. Frequent commits per task. Journal + lessons updates in the same commit as the code they describe.
