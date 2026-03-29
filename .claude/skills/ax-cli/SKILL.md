---
name: ax-cli
description: Use when modifying CLI commands — chat, send, bootstrap, plugin, or adding new CLI commands in src/cli/
---

## Overview

The CLI subsystem provides the user-facing command interface for AX. Entry point is `src/cli/index.ts` which routes commands via `routeCommand()`. Commands communicate with the AX server over a Unix socket using the OpenAI-compatible API. The chat command uses Ink (React-based terminal UI); send is a one-shot HTTP client. The plugin command manages Cowork plugins (skills + commands + MCP servers). The provider command manages third-party npm provider packages.

## Key Files

| File | Responsibility |
|---|---|
| `src/cli/index.ts` | Command router, `main()` entry point, `runServe()`, help text, --port flag, tracing init |
| `src/cli/send.ts` | One-shot message sender, streaming + JSON output |
| `src/cli/bootstrap.ts` | Agent identity reset (deletes SOUL.md/IDENTITY.md, copies templates) |
| `src/cli/plugin.ts` | Cowork plugin management: install, remove, list |
| `src/cli/provider.ts` | Provider plugin management: add, remove, list, verify |
| `src/cli/k8s-init.ts` | `ax k8s init` wizard — generates Helm values and K8s secrets for deployment |
| `src/cli/mcp.ts` | MCP server management: add, remove, list, test |
| `src/cli/setup-server.ts` | Server setup utilities (config loading, provider initialization) |
| `src/cli/reload.ts` | Hot-reload config/skills without restart |
| `src/cli/utils/commands.ts` | Command parsing helpers |
| `src/cli/utils/markdown.ts` | Markdown rendering for terminal output |

## Commands

| Command | Handler | Description |
|---|---|---|
| `ax serve` (default) | `runServe(args)` | Start HTTP server on Unix socket (or TCP with `--port`); first-run triggers `configure` |
| `ax chat` | `runChat(args)` | Interactive Ink TUI; persistent session via ConversationStore |
| `ax send <msg>` | `runSend(args)` | One-shot message; ephemeral by default (no session persistence) |
| `ax configure` | `runConfigure(axHome)` | First-time setup wizard (onboarding) |
| `ax bootstrap [agent]` | `runBootstrap(args)` | Reset agent identity; prompts confirmation if SOUL.md exists |
| `ax plugin <cmd>` | `runPlugin(args)` | Cowork plugin management: install, remove, list |
| `ax provider <cmd>` | `runProvider(args)` | Provider plugin management: add, remove, list, verify |
| `ax k8s init` | `runK8sInit(args)` | Interactive wizard for Kubernetes deployment setup |
| `ax mcp <cmd>` | `runMcp(args)` | MCP server management: add, remove, list, test |
| `ax reload` | `runReload(args)` | Hot-reload config and skills |

## Server Flags

- `--port <number>` -- Listen on TCP port instead of Unix socket (useful for containers or external clients)
- Tracing initialization: `initTracing()` called at startup when `OTEL_EXPORTER_OTLP_ENDPOINT` is set

## Chat Command (`chat.ts`)

- **Session**: Persistent. Default session ID: `main:cli:default` (via `composeSessionId`)
- **Custom session**: `--session <name>` composes `main:cli:<name>`; if name contains `:`, passed through as-is
- **Transport**: Unix socket fetch via `undici.Agent({ connect: { socketPath } })`
- **UI**: Ink React app (`App` component) with streaming support
- **Default socket**: `~/.ax/ax.sock`

## Send Command (`send.ts`)

- **Session**: Ephemeral by default (no `session_id` in request body)
- **With `--session`**: Uses same composition rules as chat
- **Input**: Positional arg or `--stdin` / `-` for piped input
- **Output modes**: Streaming SSE (default), `--no-stream` (full response), `--json` (raw OpenAI JSON)
- **SSE parsing**: Reads `data:` lines, extracts `choices[0].delta.content` until `[DONE]`

## Plugin Command (`plugin.ts`) — Cowork Plugins

- **`ax plugin install <source> [--agent <name>]`** -- Install a Cowork plugin (skills + commands + MCP servers) from GitHub or local directory
- **`ax plugin remove <name> [--agent <name>]`** -- Remove an installed Cowork plugin
- **`ax plugin list [--agent <name>]`** -- List installed Cowork plugins for an agent

## Provider Command (`provider.ts`) — npm Provider Plugins

- **`ax provider add <package>`** -- Install a provider plugin from npm, verify MANIFEST.json, prompt for review, write to plugins.lock
- **`ax provider remove <package>`** -- Uninstall a provider plugin and remove from plugins.lock
- **`ax provider list`** -- Show installed provider plugins with kind, version, and integrity status
- **`ax provider verify`** -- Re-verify all installed provider plugin integrity hashes

## Session IDs

Format: colon-separated segments with minimum 3 parts.

| Pattern | Example | Use case |
|---|---|---|
| `<agent>:<source>:<name>` | `main:cli:default` | Default CLI chat |
| `<agent>:<source>:<name>` | `main:cli:work` | Named CLI session |
| `<agent>:<channel>:<scope>:<id>` | `main:slack:dm:U12345` | Slack DM |
| UUID (legacy) | `550e8400-...` | Pre-session-ID format |

## Common Tasks

**Adding a new CLI command:**
1. Add handler signature to `CommandHandlers` interface in `index.ts`
2. Add case in `routeCommand()` switch
3. Add to `knownCommands` Set in `main()`
4. Create `src/cli/mycommand.ts` with `runMyCommand(args)` export
5. Add dynamic import in `main()` command handlers
6. Update `showHelp()` text

## K8s Init Command (`k8s-init.ts`)

Interactive wizard for generating Kubernetes deployment configuration:

- **Presets**: `small` and `large` only (medium removed) — control resource allocation. Warm pool enabled by default.
- **MCP**: Removed (MCP servers are now managed via `ax mcp` CLI commands and the database provider, not through k8s-init).
- **Compound model IDs**: Supports `provider/model` format (e.g., `anthropic/claude-sonnet-4-20250514`)
- **`extractProvider(compoundId)`** — Splits on first `/` to get provider name
- **`secretKeyForProvider(provider)`** — e.g., `anthropic` → `anthropic-api-key`
- **`envVarForProvider(provider)`** — e.g., `anthropic` → `ANTHROPIC_API_KEY`
- **Output**: Generates Helm values YAML and creates K8s secrets via `kubectl`
- **Security**: Uses `execFileSync` (not `execSync`) to prevent shell injection

## Gotchas

- **Session IDs use colons mapped to nested dirs**: `main:cli:default` becomes `data/workspaces/main/cli/default/`.
- **Legacy UUID sessions still work**: `isValidSessionId()` accepts both UUID and colon format.
- **`loadDotEnv()` called at CLI entry**: `main()` calls `loadDotEnv()` before routing. Individual commands do not re-load.
- **First-run detection in serve**: If `ax.yaml` does not exist, `runServe` automatically triggers `runConfigure`.
- **Ink requires React**: `chat.ts` imports React and Ink. The send command is plain Node.js.
- **`--port` enables TCP**: When `--port` is set, server listens on TCP in addition to (or instead of) Unix socket.
- **Tracing is opt-in**: Only enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set in environment.
- **AX_VERBOSE**: Use `AX_VERBOSE=1` env var for verbose mode (replaces `--verbose` flag in some places). Sets log level to debug via `src/cli/index.ts`.
