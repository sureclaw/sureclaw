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

### Zod transform for backward-compatible config migration
**Date:** 2026-03-02
**Context:** Migrating `credentials: 'env'` to `credentials: 'keychain'` in config.ts
**Lesson:** When renaming a config value, use `z.union([newEnum, z.literal('old')]).transform()` to accept the old value and silently remap it. Add a `console.warn` for deprecation. This avoids breaking existing ax.yaml files while encouraging migration.
**Tags:** config, zod, migration, backward-compat
