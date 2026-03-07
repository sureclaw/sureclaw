# Config: Onboarding

Configuration wizard, model selection, API key flow, task-type model routing.

## [2026-03-06 22:10] — Refactor k8s init: --model/--embeddings-model flags

**Task:** Replace `--llm-provider` and `--embeddings-provider` flags with `--model` and `--embeddings-model` that accept compound `provider/model` IDs
**What I did:** Refactored `src/cli/k8s-init.ts` to derive provider from compound model IDs (e.g. `anthropic/claude-sonnet-4-20250514`). Replaced hardcoded provider lists and lookup maps with generic `extractProvider()`, `secretKeyForProvider()`, `envVarForProvider()` helpers. Generated values now include `config.models.default` and `config.history.embedding_model`. Exported `parseArgs` and `generateValuesYaml` for testability. Rewrote tests.
**Files touched:** `src/cli/k8s-init.ts`, `tests/cli/k8s-init.test.ts`
**Outcome:** Success — 15 tests pass, full suite (2368) green
**Notes:** Any provider that follows the `PROVIDER_API_KEY` convention now works automatically — no hardcoded allowlist needed.

## [2026-03-02 22:30] — Fix OAuth refresh token persistence bugs

**Task:** OAuth `invalid_grant` error persists even after re-authenticating via `ax configure`
**What I did:**
1. **Root cause 1:** `loadDotEnv()` runs first and loads stale OAuth tokens from `~/.ax/.env` into `process.env`. `loadCredentials()` then skips those keys ("don't override shell exports"), so fresh tokens from `credentials.yaml` are never loaded.
2. **Root cause 2:** Proxy 401-retry path (`_doRefreshEnvOnly`) updates only `process.env`, not `credentials.yaml`. If the OAuth server rotates refresh tokens, the old token in `credentials.yaml` becomes invalid on next restart.
3. **Root cause 3:** `loadProviders()` loaded ALL providers (including Slack) before `loadCredentials()` seeded `process.env`. Providers that read tokens at creation time (e.g. Slack) failed because credentials.yaml values weren't in process.env yet.
4. **Fix 1:** Changed `loadCredentials()` to always use credential provider values (the authoritative source).
5. **Fix 2:** Added `forceRefreshOAuthViaProvider()` for the proxy's 401-retry path.
6. **Fix 3:** Moved credential provider loading + `loadCredentials()` into `loadProviders()` before other providers, and removed the duplicate call from `server.ts`.
7. Added regression tests: stale `.env` values are overridden by `credentials.yaml`, basic seeding works.
**Files touched:** src/dotenv.ts, src/host/server-completions.ts, src/host/registry.ts, src/host/server.ts, tests/dotenv.test.ts
**Outcome:** Success — 2193 tests pass, TypeScript build clean
**Notes:** The `.env` → `credentials.yaml` migration had three gaps: (1) stale `.env` overriding fresh credentials.yaml, (2) reactive token refresh not persisting, (3) provider loading order not accounting for credentials.yaml as the token source.

## [2026-02-26 03:35] — Add image model selection to `ax configure`

**Task:** Add optional image model prompt to the configure wizard so users don't have to manually edit ax.yaml
**What I did:**
1. Added `IMAGE_PROVIDERS`, `IMAGE_PROVIDER_DISPLAY_NAMES`, `IMAGE_PROVIDER_DESCRIPTIONS`, `DEFAULT_IMAGE_MODELS` constants to prompts.ts
2. Added `imageModel?: string` to `OnboardingAnswers`, updated config generation to build `models` object with both `default` and `image` keys conditionally, updated `loadExistingConfig` to read back `imageModel` from `parsed.models?.image?.[0]`
3. Added image generation prompt flow to configure.ts: confirm → select provider → input model name, with pre-fill from existing config
4. Added 6 new tests: image model to yaml, both models present, image-only (claude-code), omits models when neither set, loadExistingConfig reads back image model, loadConfig validation passes
**Files touched:** src/onboarding/prompts.ts, src/onboarding/wizard.ts, src/onboarding/configure.ts, tests/onboarding/wizard.test.ts
**Outcome:** Success — 157 test files, 1624 tests pass, TypeScript build clean
**Notes:** The config schema already supported `models.image` — this was purely a wizard/UI gap. The IIFE pattern for building the models object keeps the config construction readable.

## [2026-02-26 03:27] — Make models.default optional for claude-code agents

**Task:** Config validation rejected `models: { image: [...] }` without `models.default` — but claude-code agents don't use the LLM router and don't need default models
**What I did:** Made `models.default` optional in both the Zod schema (`config.ts`) and the TypeScript type (`ModelMap` in `types.ts`). The LLM router already has a runtime check that throws if `models.default` is missing, and it's only loaded for non-claude-code agents (registry.ts loads 'anthropic' stub for claude-code, 'router' for others).
**Files touched:** src/config.ts, src/types.ts
**Outcome:** Success — all 1618 tests pass, TypeScript build clean
**Notes:** `config.models?.default?.[0]` was already used with optional chaining in server.ts. The router's runtime check at router.ts:82 provides the safety net for non-claude-code agents.

## [2026-02-26 02:15] — Organize models by task type

**Task:** Restructure the flat `models` array and separate `image_models` array into a task-type-keyed model map: `models: { default, fast, thinking, coding, image }`. All non-default task types are optional and fall back to `default`.
**What I did:**
- Added `ModelTaskType`, `LLMTaskType`, `ModelMap` types to `src/types.ts`, removed `image_models` field
- Updated `src/config.ts` Zod schema: `models` is now a `strictObject` with required `default` and optional `fast`/`thinking`/`coding`/`image`
- Rewrote `src/providers/llm/router.ts` to build per-task-type candidate chains, resolve `taskType` from `ChatRequest`, fall back to `default`
- Added `taskType` field to `ChatRequest` in LLM types and to `LlmCallSchema` in IPC schemas
- Updated IPC handler (`src/host/ipc-handlers/llm.ts`) to pass `taskType` through
- Updated image router to read from `config.models.image` instead of `config.image_models`
- Updated `src/host/registry.ts` to check `config.models?.image?.length`
- Updated `src/host/server.ts` delegation config and `configModel` references
- Updated `src/agent/runner.ts` compaction call to use `taskType: 'fast'` instead of hardcoded `DEFAULT_MODEL_ID`
- Updated onboarding wizard to generate `models: { default: [...] }` format
- Updated `ax.yaml`, `README.md`, all 6 test YAML fixtures
- Updated all test files: `config.test.ts`, `router.test.ts` (LLM + image), `wizard.test.ts`, `phase1.test.ts`
- Added 3 new router tests for task-type routing behavior
**Files touched:** src/types.ts, src/config.ts, src/providers/llm/types.ts, src/providers/llm/router.ts, src/ipc-schemas.ts, src/host/ipc-handlers/llm.ts, src/host/ipc-handlers/image.ts, src/providers/image/router.ts, src/host/registry.ts, src/host/server.ts, src/agent/runner.ts, src/onboarding/wizard.ts, ax.yaml, README.md, tests/integration/ax-test*.yaml (6 files), tests/config.test.ts, tests/providers/llm/router.test.ts, tests/providers/image/router.test.ts, tests/onboarding/wizard.test.ts, tests/integration/phase1.test.ts
**Outcome:** Success — build clean, all 1600 tests pass
**Notes:** The `DEFAULT_MODEL_ID` in runner.ts is still used as a fallback for the pi-session Model object constructor — that's separate from the config-driven routing. The mock LLM provider doesn't echo back model names, so the task-type routing test verifies by setting default to a failing provider and fast to mock — if routing is wrong, the test fails.

## [2026-02-22 22:40] — Fix onboarding config: model selection & conditional API key

**Task:** Fix two bugs in `bun configure`: (1) API key asked even when not using claude-code or when using OAuth, (2) no model selection causing LLM router crash on `bun serve`
**What I did:** Added LLM provider selection (anthropic/openai/openrouter/groq) and model name input for non-claude-code agents. Restructured the auth/API key flow so claude-code agents get auth method selection (api-key/oauth) while router-based agents get provider→model→provider-specific API key. Updated wizard.ts to write model to ax.yaml and use correct env var name (e.g. OPENROUTER_API_KEY). Updated loadExistingConfig to read model back and derive provider.
**Files touched:** src/onboarding/prompts.ts, src/onboarding/wizard.ts, src/onboarding/configure.ts, tests/onboarding/wizard.test.ts, tests/onboarding/configure.test.ts
**Outcome:** Success — 45 tests pass, no TS errors in onboarding files
**Notes:** The configure flow now has two distinct paths after agent selection: claude-code (auth method → api-key/oauth) vs router-based (LLM provider → model → provider API key). This prevents the "config.model is required" error and makes the API key prompt match the actual provider.
