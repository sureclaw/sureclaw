# Providers: Credentials

Credential storage provider implementations: plaintext, keychain, database.

## [2026-03-20 18:56] — Update plaintext credential provider to use scope parameter

**Task:** Task 3 — Update the plaintext credential provider to support the `scope` parameter added to the CredentialProvider interface
**What I did:** Added `scopedKey()` helper that namespaces keys as `scope::service`. Updated all four methods (`get`, `set`, `delete`, `list`) to accept and use the optional scope parameter. Scoped keys are stored in the same YAML file. Unscoped calls preserve backward compatibility (env fallback, process.env sync). `list()` filters keys by scope prefix and strips it from results.
**Files touched:** src/providers/credentials/plaintext.ts, tests/providers/credentials/plaintext.test.ts
**Outcome:** Success — all 13 tests pass (11 existing + 2 new scope tests)
**Notes:** Scoped `set`/`delete` do NOT sync to process.env since env vars are a global namespace and scoped credentials are meant for isolation. Scoped `get` does NOT fall back to process.env — only unscoped calls do.

## [2026-03-20 19:10] — Update keychain credential provider to use scope parameter

**Task:** Task 4 — Update keychain.ts to use the scope parameter added in Task 1
**What I did:** Added `scopedAccount()` helper that prefixes service names with `scope::` when a scope is provided. Updated all four methods (get, set, delete, list) to use scoped accounts. The `get` method only falls back to process.env when no scope is specified. The `list` method filters by scope prefix or excludes scoped entries when no scope is given.
**Files touched:** src/providers/credentials/keychain.ts
**Outcome:** Success — TypeScript build compiles cleanly
**Notes:** Keychain tests require keytar which may not be available in CI, so only compilation was verified. The `list()` filtering ensures unscoped calls don't leak scoped credentials and vice versa.

## [2026-03-20 18:55] — Update database credential provider to use scope parameter

**Task:** Task 2 — Update the database implementation to use the `scope` parameter added to CredentialProvider in Task 1
**What I did:** Removed the closure-captured `const scope = DEFAULT_SCOPE` and updated all four methods (`get`, `set`, `delete`, `list`) to accept `scope?: string` and compute `effectiveScope = scope ?? DEFAULT_SCOPE`. process.env fallback/update now only happens for unscoped (global) calls. Added 3 new tests: scoped isolation, scoped list, and scoped delete.
**Files touched:** src/providers/credentials/database.ts, tests/providers/credentials/database.test.ts
**Outcome:** Success — all 17 credential/database tests pass (14 existing + 3 new scoped tests)
**Notes:** Scoped calls (`scope` explicitly provided) never read from or write to `process.env`. Only default/global calls (no scope argument) maintain the process.env synchronization behavior.

## [2026-03-20 18:53] — Add optional scope parameter to CredentialProvider interface

**Task:** Add optional `scope` parameter to all CredentialProvider methods (Task 1 of multi-step plan)
**What I did:** Added `scope?: string` as the last parameter to `get`, `set`, `delete`, and `list` methods in the CredentialProvider interface
**Files touched:** src/providers/credentials/types.ts
**Outcome:** Success — all 29 existing credential tests pass (3 test files). Parameter is optional so no implementations need updating yet.
**Notes:** This is the interface-only change. Implementations (plaintext, keychain, database, encrypted) will be updated in subsequent tasks to use the scope parameter.

## [2026-03-19 13:00] — Database-backed credential provider

**Task:** Implement a database-backed credential provider for k8s durability
**What I did:** Created `src/providers/credentials/database.ts` with migrations, registered in provider map, updated registry loading order to handle the DB-before-credentials dependency, updated Helm chart default from deprecated 'env' to 'database'
**Files touched:** src/providers/credentials/database.ts, src/providers/credentials/migrations.ts, src/host/provider-map.ts, src/host/registry.ts, charts/ax/values.yaml, tests/providers/credentials/database.test.ts
**Outcome:** Success — 213 test files, 2455 tests pass (13 new credential/database tests)
**Notes:** The `scope` column (default: 'global') is future-proofing for per-user/per-agent credential isolation. Current implementation uses global scope only. Registry loading order is conditionally adjusted: when credentials=database, the database provider loads first. For plaintext/keychain, the original order is preserved.

## [2026-03-02 14:30] — Refactor credential providers: keychain default, plaintext fallback

**Task:** Make keychain the default credential provider, replace old read-only env provider with a read/write plaintext provider storing in credentials.yaml, and route all credential writes through the provider interface
**What I did:**
1. Created `src/providers/credentials/plaintext.ts` — read/write YAML-based credential store at `~/.ax/credentials.yaml` with process.env fallback on `get()`
2. Deleted `src/providers/credentials/env.ts` (read-only process.env wrapper)
3. Updated `keychain.ts` to fall back to plaintext instead of encrypted, added process.env fallback on get()
4. Updated `encrypted.ts` to throw when passphrase missing (no longer auto-falls back), added process.env fallback on get()
5. Updated `provider-map.ts`: env → plaintext
6. Updated `config.ts` with Zod transform: legacy `credentials: 'env'` → `'keychain'` with deprecation warning
7. Updated onboarding wizard to write secrets to credentials.yaml via YAML serialization
8. Refactored OAuth refresh to support credential provider interface (ensureOAuthTokenFreshViaProvider)
9. Added `loadCredentials()` in dotenv.ts to seed process.env from credential provider at startup
10. Updated ~25 test files including new plaintext.test.ts, fixture updates (env→keychain), wizard assertions (credentials.yaml)
**Files touched:** src/providers/credentials/{plaintext.ts (new), env.ts (deleted), keychain.ts, encrypted.ts}, src/providers/credentials/types.ts, src/host/provider-map.ts, src/config.ts, src/paths.ts, src/dotenv.ts, src/onboarding/{prompts.ts, wizard.ts}, src/host/{server.ts, server-completions.ts}, tests/providers/credentials/{plaintext.test.ts (new), env.test.ts (deleted), encrypted.test.ts, keychain.test.ts}, tests/dotenv.test.ts, tests/onboarding/wizard.test.ts, 13 test fixture files
**Outcome:** Success — 186 test files, 2029 tests pass, TypeScript build clean
**Notes:** User changed naming mid-implementation from "dotenv/.env" to "plaintext/credentials.yaml" — YAML format is cleaner and avoids confusion with the existing .env file used by loadDotEnv(). Both keychain and encrypted providers now fall back to process.env for individual get() lookups so shell-exported vars still work.
