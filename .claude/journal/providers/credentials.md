# Providers: Credentials

Credential storage provider implementations: plaintext, encrypted, keychain.

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
