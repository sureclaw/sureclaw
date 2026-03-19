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
| `get` | `(service: string) => Promise<string \| null>` | Retrieve a credential by service name |
| `set` | `(service: string, value: string) => Promise<void>` | Store a credential |
| `delete` | `(service: string) => Promise<void>` | Remove a credential |
| `list` | `() => Promise<string[]>` | List all stored service names |

## Implementations

| Name | File | Storage Mechanism | Security Level |
|------|------|-------------------|----------------|
| plaintext | `src/providers/credentials/plaintext.ts` | `~/.ax/credentials.yaml` with `process.env` fallback | Low -- plaintext on disk |
| keychain | `src/providers/credentials/keychain.ts` | OS native keychain via `keytar` (macOS Keychain, GNOME Keyring, Windows Credential Locker) | High -- OS-managed |
| database | `src/providers/credentials/database.ts` | Shared DatabaseProvider (SQLite or PostgreSQL) with `process.env` fallback | Medium -- durable across restarts, k8s-ready |

All providers export `create(config: Config): Promise<CredentialProvider>`. Registered in `src/host/provider-map.ts` static allowlist (SC-SEC-002).

The `database` provider also accepts `CreateOptions` with a `database` field (like `audit/database`). Its migration is in `src/providers/credentials/migrations.ts` and uses migration table `credential_migration`.

## Common Tasks

**Adding a new credential provider:**
1. Create `src/providers/credentials/<name>.ts` exporting `create(config: Config): Promise<CredentialProvider>`
2. Implement all 4 methods: `get`, `set`, `delete`, `list`
3. Register in `src/host/provider-map.ts` static allowlist (SC-SEC-002)
4. Add tests at `tests/providers/credentials/<name>.test.ts`
5. Use `safePath()` for any file path construction from input

## MITM Credential Injection Flow

During sandbox launch (`server-completions.ts`), the host builds a `CredentialPlaceholderMap`:

1. Skill files in agent/user workspace are scanned for `requires.env` declarations
2. For each required env var, `providers.credentials.get(envName)` retrieves the real value
3. `credentialMap.register(envName, realValue)` generates an opaque `ax-cred:<hex>` placeholder
4. `credentialMap.toEnvMap()` is merged into the sandbox's `extraEnv` — agents see placeholders, not real keys
5. The MITM web proxy (`src/host/web-proxy.ts`) uses `credentialMap.replaceAllBuffer()` on decrypted HTTPS traffic to swap placeholders for real values

**Key files:**
- `src/host/credential-placeholders.ts` — `CredentialPlaceholderMap` class
- `src/host/server-completions.ts` — `collectSkillEnvRequirements()` + credential registration loop

## Interactive Credential Prompting

When a skill requires a credential that isn't in the store, the host prompts the user interactively instead of silently skipping it:

1. `server-completions.ts` detects missing credential during sandbox launch
2. Host emits `credential.required` event via event bus (contains `envName`, `sessionId`)
3. `requestCredential(sessionId, envName)` in `src/host/credential-prompts.ts` blocks until resolved or timeout (120s)
4. Resolution paths:
   - **Chat completions SSE**: Named event `event: credential_required` → client shows modal → `POST /v1/credentials/provide` with `{sessionId, envName, value}`
   - **Admin dashboard SSE**: Same event → `POST /admin/api/credentials/provide`
5. `resolveCredential(sessionId, envName, value)` unblocks the pending request
6. Provided credential is stored via `providers.credentials.set()` for future sessions
7. Credential is registered in `CredentialPlaceholderMap` for MITM injection

**Key files:**
- `src/host/credential-prompts.ts` — Pending prompt registry (request/resolve/cleanup)
- `src/host/server.ts` — SSE event emission + `POST /v1/credentials/provide` endpoint
- `src/host/server-admin.ts` — `POST /admin/api/credentials/provide` endpoint

## Gotchas

- **Credentials never enter agent containers:** The host holds credentials and injects them into outbound API requests via the MITM proxy. Agents receive opaque `ax-cred:<hex>` placeholder tokens as env vars, not real credentials.
- **Plaintext provider is read-only:** `set()` and `delete()` throw errors. Use keychain for writes.
- **Credential map is populated by reference:** The `CredentialPlaceholderMap` is created before the web proxy starts and populated later (after workspace paths are set). Since it's passed by reference, the proxy sees updates.
- **Missing credentials trigger interactive prompts:** If `providers.credentials.get()` returns null and `web_proxy` is enabled, the host emits a `credential.required` event and blocks. If the user doesn't provide within 120s, the credential is skipped.
- **Duplicate requests piggyback:** Multiple concurrent requests for the same credential (same session + envName) share a single pending entry.
- **Session cleanup:** `cleanupSession()` is called when the completion ends, resolving any remaining pending prompts with null.
- **Database provider needs DB loaded first:** When `credentials === 'database'`, the registry conditionally loads the database provider BEFORE credentials (reversed from the normal order). See `src/host/registry.ts`. For plaintext/keychain, the original order is preserved.
- **Database credential_store has a scope column:** Currently always `'global'`, but the schema supports per-user/per-agent scoping via `UNIQUE(scope, env_name)`. Future work can add `user:<id>` or `agent:<id>` scopes.
- **Helm chart default is 'database':** The k8s Helm chart (`charts/ax/values.yaml`) defaults to `credentials: database` so user-provided skill credentials survive pod restarts via PostgreSQL.
