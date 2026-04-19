# Credential Provider Lessons

### All credential providers must fall back to process.env on get()
**Date:** 2026-03-02
**Context:** Refactoring credential providers to use keychain as default
**Lesson:** Every credential provider's `get()` method should check `process.env[key]` and `process.env[key.toUpperCase()]` after checking its own store. This ensures shell-exported vars (like `OPENROUTER_API_KEY`) work regardless of which credential backend is active. The proxy reads `process.env` synchronously, so credentials must also be seeded into `process.env` at startup via `loadCredentials()`.
**Tags:** credentials, provider, process.env, fallback

### Use AX_CREDS_YAML_PATH env var override for testing credential providers
**Date:** 2026-03-02
**Context:** Writing tests for the plaintext credential provider
**Lesson:** Credential providers that write to disk (plaintext, encrypted) should support an env var override for the file path (e.g., `AX_CREDS_YAML_PATH`, `AX_CREDS_STORE_PATH`) so tests can use temp directories. Set it in `beforeEach`, clean up in `afterEach`, and always save/restore the original value.
**Tags:** credentials, testing, temp-dir, isolation

### Extending CredentialProvider requires touching every inline mock
**Date:** 2026-04-16
**Context:** Added `listScopePrefix(prefix)` to `CredentialProvider` for the skills reconciler current-state loader.
**Lesson:** There are ~7 ad-hoc inline stubs implementing `CredentialProvider` across tests (`tests/dotenv.test.ts`, `tests/host/credential-scopes.test.ts`, `tests/host/credential-injection-integration.test.ts` [×4], `tests/host/ipc-handlers/skills-credential.test.ts`, `tests/provider-sdk/harness.test.ts`, `tests/providers/mcp/database.test.ts` [×4]). Any new method on the interface needs a stub in each. Easy way to find them all: `grep -rn 'delete:\s*async' tests/` — the inline stubs all have `delete: async () => {}`. Running `npm run build` (tsc) catches the missing-method errors cleanly.
**Tags:** credentials, provider, interface, testing, tsc, mock

### LIKE prefix matching — guard against metacharacters even when input looks safe
**Date:** 2026-04-16
**Context:** Implementing `listScopePrefix(prefix)` using `Kysely.where('scope','like',`${prefix}%`)` in `src/providers/credentials/database.ts`.
**Lesson:** Even when callers only pass internally-generated strings (e.g. `user:<agentName>:`), throw on LIKE metacharacters (`%`, `_`, `\`) in the prefix. It's one line and future-proofs against a day when someone passes user-controlled data. Kysely parameterizes the full pattern so injection isn't the risk — over-matching is (`%` means "any"). Throw, don't silently escape: the caller is buggy/hostile, surface it.
**Tags:** sql, kysely, like, security, defensive

### SQLite LIKE is ASCII-case-insensitive by default — use GLOB for case-sensitive prefix matches
**Date:** 2026-04-17
**Context:** CodeRabbit review flagged `listScopePrefix('user:main:alice')` returning rows for scope `user:main:Alice` too — identities that must not collide.
**Lesson:** `LIKE` in SQLite defaults to case-insensitive matching for ASCII characters (PRAGMA `case_sensitive_like` is off by default). PostgreSQL's LIKE is case-sensitive. When matching identifiers that differ only in case, either go dialect-aware (GLOB on sqlite, LIKE on postgres) or use a dialect-portable `substr(col, 1, N) = prefix`. If you switch to GLOB, widen any metacharacter guard: GLOB metachars are `* ? [ ]`, not `%` and `_`.
**Tags:** sqlite, glob, like, case-sensitivity, kysely, cross-dialect

### Zod transform for backward-compatible config migration
**Date:** 2026-03-02
**Context:** Migrating `credentials: 'env'` to `credentials: 'keychain'` in config.ts
**Lesson:** When renaming a config value, use `z.union([newEnum, z.literal('old')]).transform()` to accept the old value and silently remap it. Add a `console.warn` for deprecation. This avoids breaking existing ax.yaml files while encouraging migration.
**Tags:** config, zod, migration, backward-compat

### `get(user_id)` with fallback to `''` needs JS-side ordering, not SQL ORDER BY
**Date:** 2026-04-18
**Context:** `SkillCredStore.get({agentId, skillName, envName, userId})` needs to prefer `user_id = $userId` over `user_id = ''` when both rows exist. SQLite and PostgreSQL disagree on whether ORDER BY with a boolean expression works portably (sqlite evaluates `user_id = $x DESC` fine, but Kysely's type system and some driver variants don't handle it cleanly).
**Lesson:** Return both candidate rows from the DB (`WHERE user_id = $x OR user_id = ''`), then sort in JS: user-scope first, agent-scope-sentinel second. Drop the rest. Avoids cross-dialect ORDER BY games on boolean expressions and keeps the tuple-preference logic explicit.
**Tags:** kysely, sqlite, postgres, cross-dialect, ordering

### Backfill "rows changed" counter needs a pre-load to be idempotent
**Date:** 2026-04-18
**Context:** Startup backfill from `credential_store` → `skill_credentials`. First run reported correct N; second run also reported N because every `put` runs ON CONFLICT DO UPDATE (still touches the row even when value is identical).
**Lesson:** For idempotent upsert-based migrations, pre-load existing tuple values into an in-memory map, then only count a row as "backfilled" when the source value differs from the destination. The DB-level upsert stays idempotent; the reporting layer distinguishes actual work from no-ops. Makes `rowsBackfilled = 0` on second boot a reliable signal.
**Tags:** backfill, migration, idempotence, upsert, kysely

### Before dropping a shared table, grep for ALL readers/writers — not just the subsystem you're migrating away from
**Date:** 2026-04-18
**Context:** Step 8 of the skills migration planned to drop `credential_store`. The skills subsystem had been fully migrated to `skill_credentials`. But `credential_store` is also read/written by non-skill paths: oauth-skills.ts (agent-initiated OAuth at unscoped keys), providers/mcp/database.ts (MCP bearer lookups), server-completions.ts (process.env fallback), inprocess.ts (CLI credential lookups), onboarding/wizard.ts (first-run setup). Dropping it would have broken ~5 unrelated features.
**Lesson:** When a migration plan says "drop table X after verifying nothing reads it," do the verification as a grep for BOTH reads AND writes, across ALL call sites — including the ones the migration didn't touch. If grep finds non-target-subsystem callers, the table stays; only the migrating subsystem's reads/writes get removed. Scope the migration to the subsystem, not to the table.
**Tags:** migration, credential-store, scope, grep, defensive
