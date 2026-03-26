---
name: ax-provider-system
description: Use when adding new provider categories, modifying provider loading, plugin infrastructure, or understanding the provider contract pattern -- registry.ts, provider-map.ts, provider-sdk, and the create(config) convention
---

## Overview

AX uses a **provider contract pattern**: every subsystem is a TypeScript interface with pluggable implementations. Implementations are selected by name in `ax.yaml`, resolved via a static allowlist (`provider-map.ts`), and instantiated by `registry.ts` calling each module's `create(config)` export. This enforces SC-SEC-002 -- no dynamic path construction. Third-party providers are supported via the plugin system and provider SDK.

## The Contract

1. Each **category** lives in `src/providers/<category>/` with a co-located `types.ts` defining the interface.
2. Each **implementation** exports `create(config: Config)` returning the provider instance.
3. `provider-map.ts` maps `(kind, name)` pairs to static import paths.
4. `registry.ts` resolves the path, imports the module, and calls `mod.create(config)`.

## Provider Categories

| Category      | Interface              | Directory                      |
|---------------|------------------------|--------------------------------|
| llm           | `LLMProvider`          | `src/providers/llm/`           |
| image         | `ImageProvider`        | `src/providers/image/`         |
| memory        | `MemoryProvider`       | `src/providers/memory/`        |
| scanner       | `ScannerProvider`      | `src/providers/scanner/`       |
| channel       | `ChannelProvider`      | `src/providers/channel/`       |
| web           | `WebProvider`          | `src/providers/web/`           |
| browser       | `BrowserProvider`      | `src/providers/browser/`       |
| credentials   | `CredentialProvider`   | `src/providers/credentials/`   |
| skills        | `SkillStoreProvider`   | `src/providers/skills/`        |
| audit         | `AuditProvider`        | `src/providers/audit/`         |
| sandbox       | `SandboxProvider`      | `src/providers/sandbox/`       |
| scheduler     | `SchedulerProvider`    | `src/providers/scheduler/`     |
| screener      | `SkillScreenerProvider`| `src/providers/screener/`      |
| database      | `DatabaseProvider`     | `src/providers/database/`      |
| storage       | `StorageProvider`      | `src/providers/storage/`       |
| eventbus      | `EventBusProvider`     | `src/providers/eventbus/`      |
| workspace     | `WorkspaceProvider`    | `src/providers/workspace/`     |
| mcp           | `McpProvider`          | `src/providers/mcp/`           |

## Provider Map (SC-SEC-002)

`src/host/provider-map.ts`:

- **Built-in allowlist** (`_PROVIDER_MAP`): frozen record mapping every valid `(kind, name)` to a relative import path. `resolveProviderPath()` throws on missing entries.
- **Plugin registry** (`_pluginProviderMap`): separate runtime allowlist for third-party plugins. Functions: `registerPluginProvider()`, `unregisterPluginProvider()`, `listPluginProviders()`, `clearPluginProviders()`.
- **URL scheme guard**: Post-resolution `assertFileUrl()` ensures all resolved paths are `file://` URLs (defense-in-depth against protocol confusion).
- **Resolution order**: Built-in allowlist checked first, then plugin registry.

## Registry

`src/host/registry.ts` exports `loadProviders(config, opts?)` returning a `ProviderRegistry`:

- Reads provider names from `config.providers.*`
- **Three loading patterns** based on provider needs:
  1. **Simple**: `loadProvider(kind, name, config)` — resolveProviderPath → import → `mod.create(config, name)`. Used by web, browser, credentials, sandbox, eventbus, workspace.
  2. **Manual import with options**: resolve path, import, call `mod.create(config, name, { ...deps })`. Used by providers that need injected dependencies:
     - **memory** gets `{ llm, database, eventbus }`
     - **scanner** gets `{ llm }` (via `loadScanner()`)
     - **skills** gets `{ screener, storage }`
     - **storage** gets `{ database }`
     - **audit** gets `{ database }`
  3. **Custom**: `loadScheduler(config, database, eventbus)` — scheduler has its own `create(config, { database, eventbus })` shape.
- **Loading order matters**: credentials → database → LLM → screener → skills → eventbus → memory → storage → audit → workspace → scanner → everything else
- Channels load as an array (`config.providers.channels` is `string[]`)
- **Image provider**: Loaded only when `config.models.image` is configured
- **Tracing wrapper**: LLM provider wrapped with `TracedLLMProvider` when `OTEL_EXPORTER_OTLP_ENDPOINT` is set
- **Plugin host integration**: Optional `opts.pluginHost` calls `pluginHost.startAll()` before loading (registers plugin providers)

## Provider SDK (for third-party plugins)

`src/provider-sdk/` provides a public SDK package for third-party provider authors:

- **`src/provider-sdk/index.ts`** -- Main entry re-exporting all interfaces, test harness, and utilities
- **`src/provider-sdk/interfaces/index.ts`** -- Re-exports all provider type interfaces from canonical `src/providers/*/types.ts`
- **`src/provider-sdk/testing/harness.ts`** -- `ProviderTestHarness` for validating provider implementations against the contract
- **`src/provider-sdk/testing/fixtures/`** -- Ready-made test fixtures (memory, scanner)
- **`src/provider-sdk/utils/safe-path.ts`** -- Re-exported `safePath()` for plugin authors

## Image Provider Category

New provider category for image generation:

| Implementation | File | Description |
|---|---|---|
| openai | `src/providers/image/openai-images.ts` | DALL-E via OpenAI API |
| openrouter | `src/providers/image/openrouter.ts` | Image gen via OpenRouter |
| groq | `src/providers/image/openai-images.ts` | Groq image gen (OpenAI-compatible) |
| gemini | `src/providers/image/gemini.ts` | Google Gemini image gen |
| router | `src/providers/image/router.ts` | Multi-provider routing based on `models.image` config |
| mock | `src/providers/image/mock.ts` | Test fixture |

## Shared Provider Types

- **`src/providers/shared-types.ts`**: Re-export hub for types used across multiple provider categories. Prevents cross-provider directory imports.
- **`src/providers/router-utils.ts`**: `parseCompoundId()` utility shared by LLM and image routers.
- **Typed unions**: `provider-map.ts` exports typed name unions for each category: `LLMProviderName`, `ImageProviderName`, `MemoryProviderName`, `ScannerProviderName`, `ChannelProviderName`, `WebProviderName`, `BrowserProviderName`, `CredentialProviderName`, `SkillsProviderName`, `DatabaseProviderName`, `AuditProviderName`, `SandboxProviderName`, `SchedulerProviderName`, `ScreenerProviderName`, `StorageProviderName`, `EventBusProviderName`, `WorkspaceProviderName`. Used in `Config.providers` for type-safe config.

## Common Tasks

### Adding an implementation to an existing category

1. Create `src/providers/<category>/<name>.ts` implementing the category interface.
2. Export `create(config: Config)` returning the provider instance.
3. Add the `(kind, name)` entry to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add a test in `tests/providers/<category>/<name>.test.ts`.

### Adding an entirely new provider category

1. Create `src/providers/<category>/types.ts` with the provider interface.
2. Create at least one implementation file exporting `create(config)`.
3. Add the category to `PROVIDER_MAP` in `src/host/provider-map.ts`.
4. Add the provider name field to `Config.providers` in `src/types.ts`.
5. Add the typed field to `ProviderRegistry` in `src/types.ts`.
6. Add the `loadProvider()` call in `registry.ts`'s `loadProviders()`.
7. Add the interface to `src/provider-sdk/interfaces/index.ts` for third-party usage.
8. Add tests in `tests/providers/<category>/`.

## Gotchas

- **Static allowlist is mandatory.** Skipping `provider-map.ts` means a runtime throw.
- **`ProviderRegistry` must match.** Forgetting the field in `src/types.ts` causes compile errors.
- **Co-located `types.ts`.** Each category owns its interface. Shared types live in `src/types.ts` or `src/providers/shared-types.ts`.
- **`channels` is an array.** `config.providers.channels` is `string[]`, returning `ChannelProvider[]`.
- **`create()` validated at runtime.** `loadProvider()` throws if the export is missing.
- **Use `safePath()`** for any file-based provider constructing paths from input.
- **Image provider is optional.** Only loaded when `config.models.image` is configured.
- **Tracing is opt-in.** LLM provider only wrapped when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
- **Plugin providers need integrity verification.** Must pass SHA-512 hash check before registration.
- **Don't import across provider categories.** Use `shared-types.ts` or `router-utils.ts` instead.
- **Providers with deps use manual import.** Memory, scanner, skills, storage, audit all receive injected dependencies via the third `options` arg to `create()`. Simple providers (web, browser, etc.) go through `loadProvider()`.
- **Scanner depends on LLM.** The guardian scanner uses the LLM for classification. It's loaded after LLM in `loadProviders()`. Other scanner implementations (patterns) ignore the extra args.
