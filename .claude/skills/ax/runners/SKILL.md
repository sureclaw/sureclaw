---
name: runners
description: Use when modifying agent runner implementations — pi-session (pi-coding-agent), claude-code (Agent SDK), LLM transport selection, MCP tool wiring, or stream handling in src/agent/runners/
---

## Overview

AX supports multiple agent runners that execute inside the sandbox. Each runner wires up LLM communication, tool registration, and output streaming differently. The entry point `runner.ts` dispatches to the appropriate runner based on config. All runners share common infrastructure: IPC client, identity loading, prompt building, tool catalog with context-aware filtering, and stream utilities.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/runner.ts` | Entry point, stdin parse, dispatch | `run()`, `parseStdinPayload()`, `compactHistory()`, `AgentConfig` |
| `src/agent/runners/pi-session.ts` | pi-coding-agent runner (history-aware, dual LLM transport) | `runPiSession()` |
| `src/agent/runners/claude-code.ts` | Claude Agent SDK runner (TCP bridge, MCP tools) | `runClaudeCode()`, `buildSDKPrompt()` |
| `src/agent/mcp-server.ts` | MCP tool registry for claude-code | `createIPCMcpServer()` |
| `src/agent/tcp-bridge.ts` | HTTP-to-Unix-socket forwarder | `startTCPBridge()`, `TCPBridge` |
| `src/agent/stream-utils.ts` | Message conversion, stream events, helpers | `convertPiMessages()`, `emitStreamEvents()`, `createSocketFetch()`, `createLazyAnthropicClient()` |
| `src/agent/ipc-transport.ts` | IPC-based LLM streaming adapter with image block injection | `createIPCStreamFn()` |
| `src/agent/tool-catalog.ts` | Single source of truth for tool metadata and context-aware filtering | `TOOL_CATALOG`, `filterTools()`, `ToolFilterContext` |
| `src/agent/nats-bridge.ts` | HTTP-to-NATS bridge for K8s claude-code sandbox pods | `NATSBridge` |
| `src/agent/identity-loader.ts` | Loads identity files from preloaded stdin payload (or filesystem fallback) | `loadIdentityFiles()` |

## Runner Dispatch

`runner.ts` parses CLI args and stdin JSON, then dispatches:

| `config.agent` | Runner | LLM Framework |
|---|---|---|
| `pi-coding-agent` | `runPiSession()` | pi-coding-agent Session |
| `claude-code` | `runClaudeCode()` | Claude Agent SDK `query()` |

Note: `pi-agent-core` was removed as a user-facing agent type.

## pi-session Runner

**Architecture**: Flexible LLM transport + pi-coding-agent session with history.

**LLM Transport Selection** (in order of preference):
1. **Proxy socket** -- Direct Anthropic SDK over Unix socket (lower latency, no IPC overhead)
2. **IPC fallback** -- Route through `ipc_client.call({action: 'llm_call'})` if proxy unavailable

**Key flow:**
1. Connect IPC client to host Unix socket
2. Create LLM stream function (proxy preferred, IPC fallback)
3. Load identity files, build system prompt via `buildSystemPrompt()` (returns prompt + `ToolFilterContext`)
4. Create IPC tools (filtered by `ToolFilterContext` -- memory, web, audit, skills, scheduler, identity/user write, delegation, image_generate)
5. Load + compact conversation history from stdin (75% context window threshold)
6. Create `AgentSession` with tools, history, custom system prompt
7. Call `session.sendMessage(userMessage)` and stream text to stdout
8. Subscribe to events: text_delta -> stdout, tool calls -> logged

**Timeout passthrough**: `LLM_CALL_TIMEOUT_MS` (configurable via `AX_LLM_TIMEOUT_MS`, defaults to 10 min) passed to IPC calls.

**Tools**: Defined as pi-ai `ToolDefinition` objects using TypeBox schemas in `ipc-tools.ts`.

## claude-code Runner

**Architecture**: TCP bridge + IPC MCP server + Agent SDK query.

**Key flow:**
1. Start TCP bridge (`startTCPBridge(proxySocket)`) -- localhost:PORT -> Unix socket proxy
2. Connect IPC client for MCP tool access
3. Create IPC MCP server (`createIPCMcpServer(client)`) exposing tools via MCP protocol
4. Build system prompt via `buildSystemPrompt()` (returns prompt + `ToolFilterContext`)
5. Call `query()` from Claude Agent SDK with:
   - `systemPrompt`: built prompt
   - `maxTurns: 20`
   - `ANTHROPIC_BASE_URL`: `http://127.0.0.1:${bridge.port}` (TCP bridge -> proxy)
   - `disallowedTools`: `['WebFetch', 'WebSearch', 'Skill']` (use AX's IPC versions)
   - `mcpServers`: the IPC MCP server
6. Stream text blocks to stdout

**Image support via `buildSDKPrompt()`**: When the user message contains `image_data` content blocks, `buildSDKPrompt()` returns an `AsyncIterable<SDKUserMessage>` with structured content blocks (text + base64 images) instead of a plain string.

**TCP Bridge** (`tcp-bridge.ts`): HTTP server on localhost:0 forwarding to Unix socket proxy. Strips encoding headers. Used for local deployments.

**NATS Bridge** (`nats-bridge.ts`): HTTP-to-NATS bridge for K8s sandbox pods. Instead of TCP bridge -> Unix socket, publishes NATS requests to `ipc.llm.{sessionId}` for LLM calls and `ipc.request.{sessionId}` for tool calls. Used when `--nats-url` is provided.

**MCP Server** (`mcp-server.ts`): Agent SDK MCP server exposing IPC tools as Zod-based tool definitions. Includes: memory_*, web_*, audit_query, identity_write, user_write, scheduler_*, skill_*, skill_import, skill_search, skill_install, agent_delegate, image_generate, workspace_write, workspace_write_file, sandbox_bash, sandbox_read_file, sandbox_write_file, sandbox_edit_file.

## Common Tasks

**Adding a tool available to both runners:**
1. Add spec to `TOOL_CATALOG` in `src/agent/tool-catalog.ts` (TypeBox)
2. Add to `src/agent/ipc-tools.ts` (pi-session -- TypeBox)
3. Add to `src/agent/mcp-server.ts` (claude-code -- Zod)
4. Add Zod schema in `src/ipc-schemas.ts` with `.strict()`
5. Add handler in `src/host/ipc-server.ts`
6. Update tool count assertion in `tests/sandbox-isolation.test.ts`
7. If context-dependent, update `filterTools()` in `tool-catalog.ts`

**Adding a new runner type:**
1. Create `src/agent/runners/<name>.ts` exporting an async function
2. Add dispatch case in `runner.ts`
3. Wire up IPC client, prompt builder, and tool registration
4. Add the agent type to `AgentType` in `src/types.ts`
5. Add to onboarding prompts in `src/onboarding/prompts.ts`

## Gotchas

- **Dual tool registration is mandatory**: Tools MUST exist in BOTH `ipc-tools.ts` AND `mcp-server.ts`. Missing one means that runner variant has no access.
- **TypeBox vs Zod**: pi-session tools use TypeBox (`@sinclair/typebox`), MCP server uses Zod v4. Don't mix them.
- **Proxy vs IPC transport**: pi-session prefers proxy (lower latency). claude-code always uses TCP bridge -> proxy. IPC fallback adds serialization overhead.
- **IPC timeout**: Configurable via `AX_LLM_TIMEOUT_MS` env var, defaults to 10 minutes. Long-running agent loops can hit this.
- **`createLazyAnthropicClient` uses `apiKey: 'ax-proxy'`**: Dummy value -- the host proxy injects the real key. Never pass real keys.
- **`convertPiMessages` uses `'.'` for empty content**: Anthropic API rejects empty strings.
- **TCP bridge strips encoding headers**: `transfer-encoding`, `content-encoding`, `content-length` removed.
- **MCP server `stripTaint()`**: Removes `taint` fields from IPC responses before returning to Agent SDK.
- **claude-code disallows WebFetch/WebSearch/Skill**: Replaced by AX's IPC-routed equivalents for taint tracking.
- **Image blocks via `buildSDKPrompt()`**: Structured content blocks only generated when `image_data` blocks are present in user message.
- **Context-aware filtering**: Both runners now use `ToolFilterContext` from `buildSystemPrompt()` to automatically exclude tools based on missing prompt modules.
- **Identity/skills via stdin payload**: The host loads identity and skills from DocumentStore and sends them in the stdin JSON payload. The agent no longer reads identity/skills from filesystem mounts. `loadIdentityFiles({ preloaded: config.identity })`.
- **NATS bridge for K8s**: claude-code uses NATS bridge instead of TCP bridge when `--nats-url` is provided. Same HTTP interface for Claude Code CLI, but NATS transport underneath.
