---
name: ax-config
description: Use when modifying configuration parsing, path resolution, environment variables, or OAuth token handling in config.ts, paths.ts, or dotenv.ts
---

## Overview

AX configuration has three layers: `ax.yaml` (parsed and Zod-validated by `config.ts`), filesystem paths (centralized in `paths.ts`), and environment variables (loaded from `~/.ax/.env` by `dotenv.ts` with OAuth auto-refresh). All files live under `~/.ax/` by default, overridable with `AX_HOME`.

## Key Files

| File | Responsibility |
|---|---|
| `src/config.ts` | Loads and validates `ax.yaml` via Zod `strictObject` schema; derives provider enums from PROVIDER_MAP |
| `src/paths.ts` | All path resolution functions; session ID validation/composition; agent workspace and identity paths |
| `src/dotenv.ts` | `.env` loader, OAuth token refresh (pre-flight + reactive) |

## Config Structure (`ax.yaml`)

Validated by `ConfigSchema` (Zod `strictObject` -- rejects unknown keys).

| Field | Type | Default | Notes |
|---|---|---|---|
| `agent` | `pi-coding-agent \| claude-code` | `pi-coding-agent` | Agent runner type |
| `models` | object with task-type keys | optional | Per-task-type model routing |
| `models.default` | string[] | optional | Default model (required for non-claude-code agents) |
| `models.fast` | string[] | optional | Fast model; falls back to 'default' |
| `models.thinking` | string[] | optional | Extended-thinking model; falls back to 'default' |
| `models.coding` | string[] | optional | Code-optimized model; falls back to 'default' |
| `models.image` | string[] | optional | Image generation model (routes to image provider) |
| `profile` | enum from `PROFILE_NAMES` | required | Personality profile |
| `providers` | object | required | Maps each category to a provider name |
| `providers.memory` | string | required | Memory provider (e.g., `sqlite`, `mock`) |
| `providers.security` | string | required | Security provider (scanner + screener) |
| `providers.channels` | string[] | required | Active channel providers |
| `providers.web` | string | required | Web provider |
| `providers.credentials` | string | required | Credentials provider |
| `providers.skills` | string | required | Skill store provider (only `database` supported) |
| `providers.audit` | string | required | Audit provider (only `database` supported) |
| `providers.sandbox` | string | required | Sandbox provider (`docker`, `apple`, `k8s`) |
| `providers.scheduler` | string | required | Scheduler provider (`none` or `plainjob`) |
| `providers.storage` | string | `database` | Storage provider (only `database` supported) |
| `providers.database` | string | optional | Database provider (e.g., `sqlite`, `postgresql`) |
| `providers.eventbus` | string | required | Event bus provider (e.g., `inprocess`, `postgres`) |
| `channel_config` | `Record<string, ChannelAccessConfig>` | optional | Per-channel access policies |
| `max_tokens` | number (256-200000) | 8192 | Max tokens for LLM calls |
| `sandbox` | object | required | `timeout_sec` (1-3600), `memory_mb` (64-8192) |
| `scheduler` | object | required | `active_hours`, `max_token_budget`, `heartbeat_interval_min`, optional `agent_dir` and `defaultDelivery` |
| `history` | object | see below | Conversation retention and memory recall settings |
| `history.max_turns` | number | 50 | Max conversation turns to retain |
| `history.thread_context_turns` | number | 5 | Turns to include from parent thread |
| `history.summarize` | boolean | false | Enable LLM-powered history summarization |
| `history.summarize_threshold` | number | 40 | Turn count threshold to trigger summarization |
| `history.summarize_keep_recent` | number | 10 | Recent turns to keep unsummarized |
| `history.memory_recall` | boolean | false | Enable semantic memory recall injection |
| `history.memory_recall_limit` | number | 5 | Max memory items to inject per turn |
| `history.memory_recall_scope` | string | `'*'` | Memory scope to search (wildcard for all) |
| `history.embedding_model` | string | `'text-embedding-3-small'` | Model for embedding generation |
| `history.embedding_dimensions` | number | 1536 | Embedding vector dimensions |
| `webhooks` | object | optional | Inbound webhook configuration |
| `webhooks.enabled` | boolean | false | Enable webhook endpoint |
| `webhooks.token` | string | required if enabled | Authentication token for webhook calls |
| `webhooks.path` | string | optional | Custom webhook URL path |
| `webhooks.max_body_bytes` | number | optional | Max request body size |
| `webhooks.model` | string | optional | LLM model for webhook transforms |
| `webhooks.allowed_agent_ids` | string[] | optional | Restrict which agents webhooks can target |
| `admin` | object | required | Admin dashboard: `enabled` (bool), `token` (string, optional), `port` (number) |
| `web_proxy` | boolean | false | Enable HTTP forward proxy for agent outbound HTTP/HTTPS (npm install, curl, etc.) |
| `namespace` | string | `ax` | K8s namespace for web proxy service discovery (`ax-web-proxy.{namespace}.svc:3128`) |
| `delegation` | object | optional | `max_concurrent` (1-10, default 3), `max_depth` (1-5, default 2) |
| `plugins` | `PluginDeclaration[]` | optional | Plugin declarations -- each maps a source to agents that use it. Auto-installed on startup. `PluginDeclaration` has `source` (string) and `agents` (string[]) fields |
| `shared_agents` | `SharedAgentConfig[]` | optional | Shared agents started alongside default. Each has `id`, `display_name`, optional `agent`, `models`, `slack_bot_token_env`, `slack_app_token_env`, `admins[]`, `capabilities[]`, `description`. See `src/types.ts` `SharedAgentConfig` |

## Models Configuration

The `models` object supports per-task-type routing:

- **`default`**: Base model for standard tasks (required for router agents, optional for claude-code)
- **`fast`**: Speed-optimized model; falls back to `default`
- **`thinking`**: Extended-reasoning model; falls back to `default`
- **`coding`**: Code-generation model; falls back to `default`
- **`image`**: Image generation model; routes to image provider, not LLM

Each value is a string array. First entry is primary model. Router-based agents require at least `models.default`.

## Paths (`paths.ts`)

| Function | Returns | Notes |
|---|---|---|
| `axHome()` | `~/.ax` or `AX_HOME` | Root for all AX files |
| `configPath()` | `~/.ax/ax.yaml` | Main config file |
| `envPath()` | `~/.ax/.env` | Environment variables file |
| `dataDir()` | `~/.ax/data` | Data subdirectory |
| `dataFile(...segs)` | `~/.ax/data/<segs>` | Resolve file under data dir |
| `workspaceDir(sessionId)` | `~/.ax/data/workspaces/<...>` | Colon IDs become nested dirs; UUIDs stay flat |
| `agentDir(name)` | `~/.ax/agents/<name>` | Agent directory |
| `agentUserDir(name, userId)` | `~/.ax/agents/<name>/users/<userId>` | Per-user state within an agent |
| `agentIdentityDir(agentId)` | `~/.ax/agents/<agentId>/agent` | Agent identity (SOUL.md, IDENTITY.md, etc.) |
| `agentWorkspaceDir(agentId)` | `~/.ax/agents/<agentId>/agent/workspace` | Agent's shared workspace |
| `agentSkillsDir(agentId)` | `~/.ax/agents/<agentId>/agent/workspace/skills` | Agent's skills directory |
| `userWorkspaceDir(agentId, userId)` | `~/.ax/agents/<agentId>/users/<userId>/workspace` | User-specific persistent workspace |
| `scratchDir(sessionId)` | `~/.ax/scratch/<...>` | Ephemeral per-session scratch |
| `registryPath()` | `~/.ax/registry.json` | Agent registry (enterprise) |
| `proposalsDir()` | `~/.ax/data/proposals` | Governance proposals directory |
| `composeSessionId(...parts)` | `part1:part2:part3` | Joins with `:`, validates, requires 3+ parts |
| `parseSessionId(id)` | `string[] \| null` | Splits colon IDs; returns null for UUIDs |
| `isValidSessionId(id)` | boolean | Accepts UUID or 3+ colon-separated segments |

## Dotenv / OAuth (`dotenv.ts`)

- **`loadDotEnv()`**: Reads `~/.ax/.env`, sets `process.env` (skips already-set keys), then calls `_refreshIfNeeded()`
- **`ensureOAuthTokenFresh()`**: Pre-flight check. Returns immediately if token has >5 min remaining.
- **`refreshOAuthTokenFromEnv()`**: Force-refresh. Used by proxy on reactive 401 retry.
- **OAuth env vars**: `CLAUDE_CODE_OAUTH_TOKEN`, `AX_OAUTH_REFRESH_TOKEN`, `AX_OAUTH_EXPIRES_AT`
- **`updateEnvFile()`**: Preserves comments and ordering; replaces matching keys in-place

## Common Tasks

**Adding a new config field:**
1. Add field to `ConfigSchema` in `config.ts` (use `.optional().default()` for backward compat)
2. Add corresponding field to the `Config` TypeScript type in `src/types.ts`
3. Both must stay in sync -- `strictObject` rejects keys not in the Zod schema

**Adding a new path helper:**
1. Add function to `paths.ts`
2. Use `axHome()` or `dataDir()` as base -- never hardcode `~/.ax`
3. Validate user-supplied segments with `validatePathSegment()` to prevent path traversal

**Adding a new model task type:**
1. Add task type to `MODEL_TASK_TYPES` array in `src/types.ts`
2. Add corresponding field to `ModelMap` interface in `src/types.ts`
3. Update `models` schema in `ConfigSchema` in `config.ts`
4. Update router fallback logic in relevant handler code

## Gotchas

- **`.env` not auto-loaded by tsx or bun scripts**: Call `loadDotEnv()` manually at entry points, or use `bun src/main.ts` directly.
- **OAuth refresh has two layers**: Pre-flight via `ensureOAuthTokenFresh()` before agent spawn, reactive 401 retry via `refreshOAuthTokenFromEnv()` in the proxy.
- **Zod strictObject rejects unknown keys**: Every field in the TypeScript `Config` type MUST also exist in `ConfigSchema`.
- **`AX_HOME` overrides all paths**: Set in tests to isolate SQLite databases and prevent lock contention.
- **Session ID segments are filesystem-safe**: Validated by `SEGMENT_RE` (`/^[a-zA-Z0-9_.@\-]+$/`). Colons are separators, never part of a segment.
- **Models are string arrays**: First entry is primary model; remaining entries for fallback.
- **Provider enums derived at runtime**: `providerEnum()` dynamically builds Zod enums from `PROVIDER_MAP` keys.
