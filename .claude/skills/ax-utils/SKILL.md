---
name: ax-utils
description: Use when working with path validation (safePath), SQLite adapter, disabled provider stubs, tracing, asset resolution, embedding client, OpenAI-compat helpers, skill format utilities, DB migrator, content serialization, binary lookup, or install validation in src/utils/
---

## Overview

The utilities module provides critical cross-cutting concerns: path traversal defense (`safePath`), a runtime-agnostic SQLite adapter, stub provider factory, OpenTelemetry tracing, dev/prod asset resolution, and skill format parsing/manifest generation. These are used throughout the codebase.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/utils/safe-path.ts` | Path traversal defense (SC-SEC-004) | `safePath()`, `assertWithinBase()` |
| `src/utils/sqlite.ts` | Runtime-agnostic SQLite wrapper | `openDatabase()`, `SQLiteDatabase`, `SQLiteStatement` |
| `src/utils/disabled-provider.ts` | Stub provider factory | `disabledProvider<T>()` |
| `src/utils/tracing.ts` | OpenTelemetry SDK initialization | `initTracing()`, `shutdownTracing()`, `getTracer()`, `isTracingEnabled()` |
| `src/utils/assets.ts` | Dev/prod mode detection, runner/template path resolution | `DEV_MODE`, `getRunnerPath()`, `getTemplatesDir()` |
| `src/utils/retry.ts` | Retry with backoff | `retry()` |
| `src/utils/circuit-breaker.ts` | Fault tolerance circuit breaker pattern | `CircuitBreaker` |
| `src/utils/database.ts` | Kysely database creation utility | `createKyselyDb()` |
| `src/utils/migrator.ts` | DB-agnostic migration runner using Kysely Migrator | `runMigrations()`, `MigrationSet`, `MigrationResult` |
| `src/utils/content-serialization.ts` | Serialize/deserialize content for storage | `serializeContent()`, `deserializeContent()` |
| `src/utils/bin-exists.ts` | Cross-platform binary lookup in PATH | `binExists()`, `BIN_NAME_REGEX` |
| ~~`src/utils/install-validator.ts`~~ | **Removed** — install validation moved to `src/agent/skill-installer.ts` | — |
| `src/utils/embedding-client.ts` | Text embedding generation via OpenAI-compatible APIs | `EmbeddingClient`, `EmbeddingClientConfig` |
| `src/utils/openai-compat.ts` | Shared OpenAI-compatible provider constants/helpers | `DEFAULT_BASE_URLS`, `envKey()`, `resolveBaseUrl()` |
| `src/utils/manifest-generator.ts` | Skill manifest generation from parsed SKILL.md | `generateManifest()`, `hashExecutables()` |
| `src/utils/skill-format-parser.ts` | AgentSkills SKILL.md format parser | `parseAgentSkill()` |
| `src/utils/nats.ts` | NATS connection options utility | `natsConnectOptions()` |

## safePath (SC-SEC-004)

**Mandatory for ALL file-based providers.** Every file operation constructing a path from external input MUST use `safePath()`.

```typescript
function safePath(baseDir: string, ...segments: string[]): string
```

**Sanitization pipeline:** strips `/`, `\`, `..`, null bytes, colons, leading/trailing dots. Resolves to absolute. Verifies containment. Throws on escape.

```typescript
function assertWithinBase(baseDir: string, targetPath: string): void
```

Validates an already-resolved path is within `baseDir`.

## SQLite Adapter

`openDatabase()` tries: bun:sqlite -> node:sqlite (22.5+) -> better-sqlite3.

**API**: `SQLiteDatabase` (exec, prepare, close), `SQLiteStatement` (run, get, all).

**PRAGMAs**: `journal_mode = WAL`, `foreign_keys = ON` set automatically.

## OpenTelemetry Tracing

`src/utils/tracing.ts` provides opt-in OpenTelemetry integration:

- **`initTracing()`** -- Lazy-loaded SDK initialization when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Auto-configures Langfuse auth if `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are present.
- **`shutdownTracing()`** -- Graceful flush and shutdown of the tracer provider.
- **`getTracer()`** -- Returns the configured tracer instance (no-op if tracing not enabled).
- **`isTracingEnabled()`** -- Returns whether tracing is active.
- **Zero overhead**: When no OTLP endpoint is configured, tracer is a no-op with negligible overhead.

## Dev/Prod Asset Resolution

`src/utils/assets.ts`:

- **`DEV_MODE`** -- Detects TypeScript source (`src/`) vs compiled JavaScript (`dist/`). True when running from `src/agent/runner.ts`.
- **`getRunnerPath()`** -- Returns `src/agent/runner.ts` in dev mode, `dist/agent/runner.js` in production.
- **`getTemplatesDir()`** -- Resolves templates directory from project root.
- **`getSeedSkillsDir()`** -- Resolves seed skills directory.
- **EPERM handling**: `enforceTimeout()` in sandbox utils wraps kill in try/catch for tsx-wrapped agents that may throw EPERM on signal.

## Skill Format Parser

`src/utils/skill-format-parser.ts`:

- **`parseAgentSkill(raw)`** -- Parses SKILL.md frontmatter and body into `ParsedAgentSkill`.
- **Frontmatter**: YAML between `---` delimiters. Supports metadata aliases: `openclaw`, `clawdbot`, `clawdis`.
- **Install specs**: Normalizes brew (formula), npm, go, uv, pip, cargo packages.
- **Permission mapping**: OpenClaw terms -> AX IPC actions (`full-disk-access` -> `workspace_write`, `web-access` -> `web_fetch`, etc.).
- **Code block extraction**: All fenced code blocks extracted into `codeBlocks[]`.

## Manifest Generator

`src/utils/manifest-generator.ts`:

- **`generateManifest(parsed)`** -- Creates `GeneratedManifest` from `ParsedAgentSkill` via static analysis.
- **Static analysis**: Detects host commands (docker, git, kubectl), env vars (ALL_CAPS patterns), domains (from URLs), IPC tools, script paths.
- **`hashExecutables(manifest, skillDir)`** -- Adds SHA-256 hashes to manifest executable entries.

## Embedding Client

`src/utils/embedding-client.ts`:

- **`EmbeddingClient`** interface with `embed(texts)`, `dimensions`, `available` properties
- Uses OpenAI-compatible embedding APIs (default: `text-embedding-3-small`)
- **Compound model IDs:** Supports `provider/model` format (e.g., `openai/text-embedding-3-small`)
- **Graceful degradation:** Returns `available: false` when API key is unavailable; callers can fall back to non-semantic search
- Used by `src/host/memory-recall.ts` and `src/providers/memory/cortex/embedding-store.ts`

## OpenAI-Compatible Helpers

`src/utils/openai-compat.ts`:

- **`DEFAULT_BASE_URLS`** -- Maps provider names to their API base URLs (OpenAI, Groq, OpenRouter, Fireworks, DeepInfra)
- **`envKey(providerName)`** -- Returns the expected `${PROVIDER}_API_KEY` env var name
- **`resolveBaseUrl(providerName)`** -- Resolves the correct base URL from env vars or defaults
- Used by LLM providers (`src/providers/llm/openai.ts`) and the embedding client

## Database Migrator

`src/utils/migrator.ts`:

- **`runMigrations(db, migrations, migrationTableName?)`** — Runs all pending Kysely migrations against a DB instance.
- **Per-subsystem isolation**: Each subsystem passes a unique `migrationTableName` (e.g. `'storage_migration'`, `'cortex_migration'`) so migration histories don't collide when sharing the same database.
- **Database-level locking**: Concurrent calls are safe.
- **Returns**: `{ error?, applied, names }` — check `result.error` before proceeding.

## Content Serialization

`src/utils/content-serialization.ts`:

- **`serializeContent(content)`** — Strings stored as-is. `ContentBlock[]` arrays are JSON-stringified. Strips `image_data` blocks (transient base64) before persisting.
- **`deserializeContent(raw)`** — Detects JSON arrays by checking if string starts with `[`. Falls back to plain string.

## Binary Lookup

`src/utils/bin-exists.ts`:

- **`binExists(name)`** — Cross-platform binary lookup via `command -v` (POSIX) or `where` (Windows).
- **Security**: Input validated against strict regex `BIN_NAME_RE` (`[a-zA-Z0-9_.-]+`) — rejects paths, shell operators, metacharacters.
- Used by skill install validation to check prerequisite binaries.

## Skill Installer (moved to agent)

The `install-validator.ts` utility has been removed. Skill dependency installation is now handled by `src/agent/skill-installer.ts` which reads SKILL.md install specs, checks for missing binaries, and runs installs with package-manager prefix env vars.

## Shared Migrations

`src/migrations/`:

- **`dialect.ts`** — Shared SQL dialect helpers: `sqlNow(dbType)`, `sqlEpoch(dbType)` for SQLite/PostgreSQL compatibility.
- **`files.ts`**, **`jobs.ts`**, **`orchestration.ts`** — Per-subsystem migration definitions.

## NATS Connection Options

`src/utils/nats.ts`:

- **`natsConnectOptions()`** — Returns consistent NATS connection configuration options. Used by `src/agent/runner.ts` (work dispatch) and `src/host/server-k8s.ts` (NATS connection) to share connection settings.

## Disabled Provider

Returns a `Proxy` that throws `"Provider disabled"` on any property access or method call. Used for `none` provider implementations.

## Common Tasks

**Adding a new sanitization rule to safePath:**
1. Add the sanitization step to the pipeline in `safe-path.ts`
2. Add test cases in `tests/utils/safe-path.test.ts`
3. Verify existing tests still pass

**Supporting a new SQLite runtime:**
1. Add detection attempt in the try chain in `sqlite.ts`
2. Ensure it implements `SQLiteDatabase`/`SQLiteStatement`
3. Test with both `npm test` and `bun test`

## Gotchas

- **`safePath()` is NOT optional**: Security invariant. Skipping it is a path traversal vulnerability.
- **SQLite WAL mode requires cleanup in tests**: Remove `-wal` and `-shm` sidecar files.
- **Runtime detection order matters**: bun:sqlite first. Under Bun, it always wins.
- **Disabled provider throws on ANY access**: Even property reads throw.
- **`safePath` strips more than you'd expect**: Colons, leading dots, trailing dots all stripped.
- **SQLite `close()` is important**: Open handles prevent directory deletion on some platforms.
- **Tracing is opt-in**: Only enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Zero overhead otherwise.
- **DEV_MODE detection**: Based on file extension of the running module. Don't rely on NODE_ENV.
