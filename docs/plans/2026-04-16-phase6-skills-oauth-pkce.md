# Phase 6 — OAuth PKCE Flow (+ Admin-Registered OAuth Fallback)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Setup cards with `authType: oauth` show a "Connect with <provider>" button. Clicking it runs a PKCE flow: dashboard generates verifier+challenge, opens the skill's `authorizationUrl`, the existing `/v1/oauth/callback/:provider` endpoint exchanges the code for a token and stores it at the configured scope. Admin-registered providers (with pre-configured `clientId`/`clientSecret`) take precedence — invisible to the end user.

**Architecture:** Reuse the existing `src/host/oauth.ts` / `src/host/oauth-skills.ts` primitives (already handle the callback). Add a "start flow" endpoint that records the pending flow and returns the auth URL with the challenge; dashboard opens it in a new tab. Callback writes the token and flips the card to "Connected".

---

## Constraints
- **PKCE default** — no client secret in frontmatter. Only admin-registered providers use the confidential flow.
- State parameter is cryptographically random, time-bounded, single-use. Existing pattern in `oauth-skills.ts` extended.
- Access tokens stored via `CredentialProvider` at the declared scope — same mechanism as API-key path.
- Refresh tokens handled (if returned) by storing `<envName>_REFRESH`; agent-side refresh happens transparently in the proxy placeholder path.

---

## Tasks (high-level)

1. **Admin settings for OAuth providers:** new sqlite table `admin_oauth_providers(provider TEXT PK, client_id TEXT, client_secret_enc TEXT NULL, redirect_uri TEXT)` + admin UI for CRUD. Secret encrypted at rest using existing secret-store helper if one exists; otherwise document the requirement and add a minimal AES-GCM wrapper.
2. **`POST /v1/admin/skills/oauth/start`:** body `{agentId, skillName, envName}`. Looks up the frontmatter-declared OAuth block in `skill_states`, or admin-registered if present. Generates verifier+challenge+state. Returns `{authUrl}`. Persists `{state→{agentId,skillName,envName,verifier,scope,provider,tokenUrl,clientId,clientSecret?}}` in memory (with TTL).
3. **Extend `/v1/oauth/callback/:provider`:** current flow handles the exchange for existing skills; extend to also look up the state map populated by `oauth/start`, exchange the code (using verifier + optional secret), store the token via `credentials.set(envName, token, scope)`, and trigger a reconcile.
4. **Refresh-token path (optional for this phase):** if `refresh_token` present in the response, store under `<envName>_REFRESH`; add a background refresh task.
5. **Dashboard button + polling:** "Connect with <provider>" opens `authUrl` in new tab; page polls `/v1/admin/skills/setup` every 2s until that credential appears; then flips card to "Connected".

**Files touched:** `src/host/oauth-skills.ts`, `src/host/server-admin.ts`, new admin UI components under `ui/admin/src/components/pages/`, tests under `tests/host/`.

**Commit hints:** `feat(oauth): admin-registered provider fallback + secret storage`, `feat(oauth): /v1/admin/skills/oauth/start PKCE initiation`, `feat(oauth): callback stores skill credential + triggers reconcile`, `feat(admin): OAuth button + connected-state UI`.
