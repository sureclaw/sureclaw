---
name: ax-provider-credentials
description: Use when modifying credential storage providers — plaintext env vars, OS keychain, or database-backed in src/providers/credentials/
---

## Overview

Credential providers store and retrieve secrets (API keys, tokens) for the host process. Credentials never enter agent containers -- the host injects them via the credential-injecting proxy at request time.

## Interface

Defined in `src/providers/credentials/types.ts`:

| Method | Signature | Purpose |
|--------|-----------|---------|
| `get` | `(service: string, scope?: string) => Promise<string \| null>` | Retrieve a credential by service name and scope |
| `set` | `(service: string, value: string, scope?: string) => Promise<void>` | Store a credential |
| `delete` | `(service: string, scope?: string) => Promise<void>` | Remove a credential |
| `list` | `(scope?: string) => Promise<string[]>` | List stored service names for a scope |

### Credential Scopes

Credentials are scoped per agent and per user. Skills are per-agent or per-user, so credentials should never be stored at global scope for skill use.

| Scope | Format | Example | Purpose |
|-------|--------|---------|---------|
| Agent | `agent:<agentName>` | `agent:main` | Shared credential for all users of this agent |
| User | `user:<agentName>:<userId>` | `user:main:alice` | Credential specific to one user of this agent |
| Global | (no scope / `undefined`) | — | Legacy/backward compat for onboarding, OAuth |

**Lookup order:** `user:<agentName>:<userId>` → `agent:<agentName>`. Use `resolveCredential()` from `src/host/credential-scopes.ts` for this fallback chain. User scope always overrides agent scope when both exist for the same `envName`.

**Helper functions** in `src/host/credential-scopes.ts`:
- `credentialScope(agentName, userId?)` — builds the scope key string
- `resolveCredential(provider, envName, agentName, userId?)` — tries user scope first, falls back to agent scope

## Implementations

| Name | File | Storage Mechanism | Security Level |
|------|------|-------------------|----------------|
| plaintext | `src/providers/credentials/plaintext.ts` | `~/.ax/credentials.yaml` with `process.env` fallback | Low -- plaintext on disk |
| keychain | `src/providers/credentials/keychain.ts` | OS native keychain via `keytar` (macOS Keychain, GNOME Keyring, Windows Credential Locker) | High -- OS-managed |
| database | `src/providers/credentials/database.ts` | Shared DatabaseProvider (SQLite or PostgreSQL) with `process.env` fallback | Medium -- durable across restarts, k8s-ready |

All providers export `create(config: Config): Promise<CredentialProvider>`. Registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002).

The `database` provider also accepts `CreateOptions` with a `database` field (like `audit/database`). Its migration is in `src/providers/credentials/migrations.ts` and uses migration table `credential_migration`.

**Scoped storage implementation details:**
- **database**: Uses the existing `scope` column in `credential_store` table. `UNIQUE(scope, env_name)` index handles isolation. No migration needed.
- **plaintext**: Stores scoped keys as `scope::env_name` in the YAML file (e.g., `agent:main::LINEAR_API_KEY`). `list()` filters by prefix.
- **keychain**: Uses `scope::service` as the keytar account name. `list()` filters by prefix on `findCredentials()` results.
- All providers: `process.env` fallback only applies for unscoped (global) calls.

## Common Tasks

**Adding a new credential provider:**
1. Create `src/providers/credentials/<name>.ts` exporting `create(config: Config): Promise<CredentialProvider>`
2. Implement all 4 methods: `get`, `set`, `delete`, `list` — all with optional `scope` parameter
3. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
4. Add tests at `tests/providers/credentials/<name>.test.ts` including scoped isolation tests
5. Use `safePath()` for any file path construction from input

## MITM Credential Injection Flow

During sandbox launch (`server-completions.ts`), the host builds a `CredentialPlaceholderMap`:

1. Skill files in agent/user workspace are scanned for `requires.env` declarations
2. For each required env var, `resolveCredential(providers.credentials, envName, agentName, userId)` resolves the value (user scope → agent scope)
3. `credentialMap.register(envName, realValue)` generates an opaque `ax-cred:<hex>` placeholder
4. `credentialMap.toEnvMap()` is merged into the sandbox's `extraEnv` — agents see placeholders, not real keys
5. The MITM web proxy (`src/host/web-proxy.ts`) uses `credentialMap.replaceAllBuffer()` on decrypted HTTPS traffic to swap placeholders for real values

**User scope overrides agent scope:** When both `user:main:alice` and `agent:main` have a value for the same `envName`, the user-scoped value is what gets registered in `credentialMap` and injected into the sandbox.

**Key files:**
- `src/host/credential-placeholders.ts` — `CredentialPlaceholderMap` class
- `src/host/credential-scopes.ts` — `resolveCredential()` and `credentialScope()` helpers
- `src/host/server-completions.ts` — `collectSkillEnvRequirements()` + credential registration loop

## Interactive Credential Prompting

When a skill requires a credential that isn't in the store, the host prompts the user via a non-blocking fire-and-forget flow (no blocking — sandbox is not held idle):

1. `server-completions.ts` detects missing credential during sandbox launch
2. Host emits `credential.required` event via event bus (contains `envName`, `sessionId`, `agentName`, `userId`)
3. Host registers session context (`setSessionCredentialContext(sessionId, {agentName, userId})`) so the provide endpoint can resolve scopes later
4. Host returns early with a message telling the user to provide the credential
5. Resolution paths:
   - **Chat completions SSE**: Named event `event: credential_required` with `{envName, sessionId}` → client shows modal → `POST /v1/credentials/provide` with `{sessionId, envName, value}`
   - **Admin dashboard SSE**: Same event → `POST /admin/api/credentials/provide` with `{sessionId, envName, value}`
6. Provide endpoint looks up `agentName`/`userId` from session context, stores at correct scopes
7. User sends a new message — next turn picks up the credential from the store

**Client API is simple:** The client only needs to echo back the `sessionId` from the SSE event. The host resolves `agentName`/`userId` internally — clients never see or send scope information.

**Key files:**
- `src/host/credential-scopes.ts` — Session context registry (`setSessionCredentialContext`/`getSessionCredentialContext`)
- `src/host/server-request-handlers.ts` — SSE event emission + `POST /v1/credentials/provide` endpoint
- `src/host/server-admin.ts` — `POST /admin/api/credentials/provide` endpoint

## credential_request IPC Handler

When the agent calls `skill({ type: "request_credential", envName })`, the `credential_request` IPC handler:

1. Records the `envName` in the session's `requestedCredentials` map
2. Checks credential availability via `resolveCredential()` (user scope → agent scope)
3. Returns `{ ok: true, available: boolean }` — the agent knows whether to tell the user the credential is still needed

**File:** `src/host/ipc-handlers/skills.ts`

## Gotchas

- **Credentials never enter agent containers:** The host holds credentials and injects them into outbound API requests via the MITM proxy. Agents receive opaque `ax-cred:<hex>` placeholder tokens as env vars, not real credentials.
- **Credential scopes prevent multi-user clobbering:** Two users providing different values for the same `envName` are stored at different scopes (`user:main:alice` vs `user:main:bob`). The `credential_store.scope` column and `UNIQUE(scope, env_name)` index enforce isolation.
- **User scope overrides agent scope for sandbox injection:** `resolveCredential()` checks user scope first. Alice's personal API key always overrides the shared org key in her sandbox.
- **Plaintext provider uses `scope::env_name` YAML keys:** Scoped credentials are stored as namespaced keys (e.g., `agent:main::LINEAR_API_KEY`). `list()` filters by prefix.
- **process.env fallback only for unscoped calls:** Scoped `get()` does NOT fall back to `process.env`. Only unscoped (global) calls do.
- **Credential map is populated by reference:** The `CredentialPlaceholderMap` is created before the web proxy starts and populated later (after workspace paths are set). Since it's passed by reference, the proxy sees updates.
- **Non-blocking credential prompts:** Missing credentials emit a `credential.required` event and return early. No blocking, no idle sandboxes, no cross-replica coordination needed.
- **credential_request returns availability:** The IPC handler returns `{ ok: true, available: boolean }` so the agent can inform the user when a credential is still needed.
- **Database provider needs DB loaded first:** When `credentials === 'database'`, the registry conditionally loads the database provider BEFORE credentials (reversed from the normal order). See `src/host/registry.ts`. For plaintext/keychain, the original order is preserved.
- **Helm chart default is 'database':** The k8s Helm chart (`charts/ax/values.yaml`) defaults to `credentials: database` so user-provided skill credentials survive pod restarts via PostgreSQL.
- **HTTP endpoint uses session context:** The `/v1/credentials/provide` endpoint accepts `{sessionId, envName, value}`. The host looks up `agentName`/`userId` from an in-memory session context map (populated during completions). If no session context is found (e.g., no prior `credential.required` event), the credential is stored at global scope for backward compat.
- **Session context persists beyond completion:** `setSessionCredentialContext()` is called when the completion starts and is NOT cleared in the finally block — the user provides credentials after the completion returns.
