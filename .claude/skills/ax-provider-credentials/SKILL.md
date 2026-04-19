---
name: ax-provider-credentials
description: Use when modifying credential storage — database-backed credential provider in src/providers/credentials/
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

Credentials for skills live in a tuple-keyed table `skill_credentials (agent_id, skill_name, env_name, user_id)`. `user_id = ''` is the agent-scope sentinel (shared across users); a non-empty `user_id` is per-user. Turn-time lookup prefers the user_id match and falls back to `''`.

The legacy `credential_store` table (`scope` column) is retained for backward compat during the Phase 5-8 cutover. Dual-write from the approve handler keeps both populated until Step 8 removes the legacy table.

**Tuple store API** in `src/host/skills/skill-cred-store.ts`:
- `put({agentId, skillName, envName, userId, value})` — upsert
- `get({agentId, skillName, envName, userId})` — prefers user_id match, falls back to `''`
- `listForAgent(agentId)` — every row for the agent (turn-time injection reads this)
- `listEnvNames(agentId)` — distinct envNames for the agent (Approvals hint probe)

## Implementation

| Name | File | Storage Mechanism | Security Level |
|------|------|-------------------|----------------|
| database | `src/providers/credentials/database.ts` | Shared DatabaseProvider (SQLite or PostgreSQL) with `process.env` fallback | Medium -- durable across restarts, k8s-ready |

The provider exports `create(config: Config): Promise<CredentialProvider>`. Registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002).

The `database` provider also accepts `CreateOptions` with a `database` field (like `audit/database`). Its migration is in `src/providers/credentials/migrations.ts` and uses migration table `credential_migration`.

**Scoped storage:** Uses the `scope` column in `credential_store` table. `UNIQUE(scope, env_name)` index handles isolation. `process.env` fallback only applies for unscoped (global) calls.

## Common Tasks

**Modifying the credential provider:**
1. Edit `src/providers/credentials/database.ts` — implements all 4 methods: `get`, `set`, `delete`, `list` — all with optional `scope` parameter
2. The provider is registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
3. Tests are at `tests/providers/credentials/database.test.ts` including scoped isolation tests
4. Use `safePath()` for any file path construction from input

## MITM Credential Injection Flow

During sandbox launch (`server-completions.ts`), the host builds a `CredentialPlaceholderMap`:

1. `deps.skillCredStore.listForAgent(agentId)` returns every row for the agent.
2. Rows are sorted so the caller's `userId` match comes before the `''` sentinel.
3. For each applicable row (user_id === currentUserId OR user_id === ''), the first-seen envName wins — user-scope overrides agent-scope automatically.
4. `credentialMap.register(envName, realValue)` generates an opaque `ax-cred:<hex>` placeholder (or writes the real value to `credentialEnv` when `web_proxy` is disabled).
5. `credentialMap.toEnvMap()` is merged into the sandbox's `extraEnv` — agents see placeholders, not real keys.
6. The MITM web proxy (`src/host/web-proxy.ts`) uses `credentialMap.replaceAllBuffer()` on decrypted HTTPS traffic to swap placeholders for real values.

**Semantic tightening (Phase 5+):** Only credentials DECLARED by an enabled skill get injected. The old "inject everything in `credential_store`" loop is gone.

**Key files:**
- `src/host/credential-placeholders.ts` — `CredentialPlaceholderMap` class
- `src/host/skills/skill-cred-store.ts` — `SkillCredStore` tuple-keyed API
- `src/host/server-completions.ts` — turn-start injection loop

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
- `src/host/session-credential-context.ts` — Session context registry (`setSessionCredentialContext`/`getSessionCredentialContext`)
- `src/host/server-request-handlers.ts` — SSE event emission + `POST /v1/credentials/provide` endpoint
- `src/host/server-admin.ts` — `POST /admin/api/credentials/provide` endpoint

## credential_request IPC Handler

When the agent calls the standalone `request_credential` tool (`credential_request` IPC action, `envName` param), the handler:

1. Records the `envName` in the session's `requestedCredentials` map
2. Checks credential availability (legacy path — still reads the scope-string table during the cutover)
3. Returns `{ ok: true, available: boolean }` — the agent knows whether to tell the user the credential is still needed

**File:** `src/host/ipc-handlers/skills.ts`

## Gotchas

- **Credentials never enter agent containers:** The host holds credentials and injects them into outbound API requests via the MITM proxy. Agents receive opaque `ax-cred:<hex>` placeholder tokens as env vars, not real credentials.
- **Tuple-keyed storage prevents multi-user clobbering:** `(agent_id, skill_name, env_name, user_id)` is the PK on `skill_credentials`. `user_id = ''` is the agent-scope sentinel; real userId for per-user rows.
- **User scope overrides agent scope for sandbox injection:** The turn-start injection loop sorts user_id=currentUserId rows first; first-seen envName wins, so user rows beat agent-scope rows.
- **process.env fallback only for unscoped calls:** Scoped `get()` does NOT fall back to `process.env`. Only unscoped (global) calls do.
- **Credential map is populated by reference:** The `CredentialPlaceholderMap` is created before the web proxy starts and populated later (after workspace paths are set). Since it's passed by reference, the proxy sees updates.
- **Non-blocking credential prompts:** Missing credentials emit a `credential.required` event and return early. No blocking, no idle sandboxes, no cross-replica coordination needed.
- **credential_request returns availability:** The IPC handler returns `{ ok: true, available: boolean }` so the agent can inform the user when a credential is still needed.
- **Database provider needs DB loaded first:** The registry conditionally loads the database provider BEFORE credentials (reversed from the normal order). See `src/host/registry.ts`.
- **HTTP endpoint uses session context:** The `/v1/credentials/provide` endpoint accepts `{sessionId, envName, value}`. The host looks up `agentName`/`userId` from an in-memory session context map (populated during completions). If no session context is found (e.g., no prior `credential.required` event), the credential is stored at global scope for backward compat.
- **Session context persists beyond completion:** `setSessionCredentialContext()` is called when the completion starts and is NOT cleared in the finally block — the user provides credentials after the completion returns.
