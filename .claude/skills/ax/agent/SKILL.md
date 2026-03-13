---
name: agent
description: Use when modifying the sandboxed agent process — runner, IPC client, local/IPC tools, tool catalog, prompt building, or identity loading in src/agent/
---

## Overview

The agent subsystem runs inside a sandboxed process (no network, no credentials). It receives a user message + history via stdin, builds a system prompt from modular components, registers IPC tools with context-aware filtering, then runs an LLM agent loop that streams text output to stdout. All LLM calls, tool operations (including bash/file ops), and privileged operations route through IPC to the trusted host.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/runner.ts` | Entry point, stdin parse, agent dispatch | `run()`, `parseStdinPayload()`, `compactHistory()`, `historyToPiMessages()`, `AgentConfig` |
| `src/agent/ipc-client.ts` | Length-prefixed Unix socket IPC with heartbeat keep-alive | `IPCClient` (connect, call, disconnect, reconnect) |
| `src/agent/tool-catalog.ts` | Single source of truth for tool metadata and context-aware filtering | `TOOL_CATALOG`, `filterTools()`, `ToolFilterContext`, `normalizeOrigin()`, `normalizeIdentityFile()` |
| `src/agent/ipc-tools.ts` | Tools that proxy to host via IPC (pi-session runner) | `createIPCTools(client, opts)` |
| `src/host/ipc-handlers/sandbox-tools.ts` | IPC handlers for bash/file ops (host-side) | `createSandboxToolHandlers()` |
| `src/agent/identity-loader.ts` | Loads identity files from preloaded stdin payload (or filesystem fallback) | `loadIdentityFiles(opts)` |
| `src/agent/agent-setup.ts` | Shared setup: prompt building, event subscription, tool filtering | `buildSystemPrompt()`, `subscribeAgentEvents()` |
| `src/agent/prompt/builder.ts` | Assembles system prompt from ordered modules | `PromptBuilder`, `PromptResult` |
| `src/agent/prompt/types.ts` | PromptContext, PromptModule interface, IdentityFiles | `PromptContext`, `PromptModule`, `IdentityFiles` |
| `src/agent/ipc-transport.ts` | IPC LLM stream function; converts IPC responses to pi-ai events with image block support | `createIPCStreamFn()` |
| `src/agent/proxy-stream.ts` | Proxy-based LLM stream function; routes via credential-injecting proxy | `createProxyStreamFn()`, `makeProxyErrorMessage()` |
| `src/agent/runners/pi-session.ts` | pi-coding-agent runner variant with proxy or IPC LLM transport | `runPiSession()` |
| `src/agent/runners/claude-code.ts` | Claude Code runner variant with Agent SDK | `runClaudeCode()`, `buildSDKPrompt()` |
| `src/agent/mcp-server.ts` | MCP tool registry for claude-code runner | `createIPCMcpServer()`, `MCPServerOptions` |

## Agent Boot Sequence

1. `runner.ts` parses CLI args (`--agent`, `--ipc-socket`, `--workspace`, `--proxy-socket`, etc.)
2. Reads stdin as JSON (`{message, history, taintRatio, profile, sessionId, identity, skills, ...}`) via `parseStdinPayload()`
3. Dispatches to runner: `runPiSession()` or `runClaudeCode()`
4. Runner connects `IPCClient` to host Unix socket
5. Loads identity files from stdin payload (preloaded from DocumentStore by host) via `loadIdentityFiles({ preloaded: config.identity })`
6. Skills loaded from stdin payload (array of `{name, description, path}`)
7. `buildSystemPrompt()` builds both the system prompt AND a `ToolFilterContext` for context-aware tool filtering
7. Creates IPC tools (catalog-based, filtered) — sandbox tools (bash, read_file, write_file, edit_file) route through IPC to host-side handlers
8. Optionally compacts history if exceeding 75% of context window via IPC LLM summarization
9. Creates agent (pi-coding-agent AgentSession or Claude Code query) with tools, prompt, history, and stream function
10. Streams response to stdout

## Tool System

- **Tool Catalog** (`tool-catalog.ts`): Single source of truth. Defines `TOOL_CATALOG` (TypeBox-based specs) and `filterTools(ctx)` for context-aware filtering.
- **Context-aware filtering**: `ToolFilterContext` flags (hasHeartbeat, hasSkills, hasWorkspaceTiers, hasGovernance) control which tools are available. Filtering is automatic in both pi-session and claude-code runners.
  - No heartbeat content -> no scheduler tools
  - No skills loaded -> no skill tools
  - No workspace tiers -> no workspace tools
  - No governance mode -> no governance tools
- **IPC tools** (`ipc-tools.ts` for pi-session, `mcp-server.ts` for claude-code): All tools proxy to host via IPC -- `memory_*`, `web_*`, `audit_query`, `identity_write`, `user_write`, `scheduler_*`, `skill_*`, `skill_import`, `skill_search`, `agent_delegate`, `image_generate`, `workspace_*`, `identity_propose`, `proposal_list`, `agent_registry_list`, `sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_edit_file`. Each calls `client.call({action, ...params})`.
- **Sandbox tools** (host-side `src/host/ipc-handlers/sandbox-tools.ts`): `bash`, `read_file`, `write_file`, `edit_file` route through IPC to the host process which executes them in the workspace directory. Uses `safePath()` for path containment. Host resolves workspace via a shared `workspaceMap` (Map<sessionId, path>).
- **AgentTool pattern** (pi-session): `{name, label, description, parameters: Type.Object({...}), execute(id, params)}`. Parameters use TypeBox (`@sinclair/typebox`), NOT Zod.
- **MCP tool pattern** (claude-code): Zod-based tool definitions wrapped in `tool()` from Agent SDK.
- **LLM routing**: Via proxy (Anthropic SDK over Unix socket) if `--proxy-socket` is provided, else IPC. Never direct API calls from the agent.
- **Heartbeat keep-alive** (ipc-client.ts): IPC calls receive heartbeat frames (`{_heartbeat: true, ts}`) to prevent timeout on long-running operations. Timeout resets on each heartbeat.
- **Image handling**: ContentBlock[] with `type: 'image'` (fileId ref) or `type: 'image_data'` (inline base64). Injected into the last plain-text user message for LLM calls.

## Prompt Builder & Modules

`PromptBuilder` holds an ordered list of `PromptModule` instances, sorted by `priority` (lower = earlier). Each module implements `shouldInclude(ctx)`, `render(ctx)`, `estimateTokens(ctx)`, and optionally `renderMinimal(ctx)`.

| Module | Priority | Content | Optional |
|---|---|---|---|
| IdentityModule | 0 | SOUL.md, IDENTITY.md, BOOTSTRAP.md, USER.md | No |
| InjectionDefenseModule | 5 | Prompt injection defenses | No |
| SecurityModule | 10 | Taint awareness, identity ownership rules | No |
| ToolStyleModule | 12 | Tool invocation instructions | No |
| MemoryRecallModule | 60 | Memory recall pattern instructions | No |
| SkillsModule | 70 | Loaded skill definitions | Yes |
| DelegationModule | 75 | Agent delegation instructions + runner selection guide | Yes |
| HeartbeatModule | 80 | HEARTBEAT.md periodic check schedule | Yes |
| RuntimeModule | 90 | Agent type, sandbox type, tool list | No |
| ReplyGateModule | 95 | Reply optionality logic | No |

Budget allocation (`budget.ts`) can drop `optional` modules or switch to `renderMinimal` when context is tight. The `PromptBuildResult` includes metadata and a `ToolFilterContext` that runners use to filter tools.

## Identity

| File | Purpose |
|---|---|
| `SOUL.md` | Core personality, values, voice -- shared across all users |
| `IDENTITY.md` | Self-description, capabilities, evolving self-model |
| `BOOTSTRAP.md` | First-session instructions (shown only when SOUL.md is absent) |
| `USER.md` | Per-user preferences (stored at `agentDir/users/<userId>/USER.md`) |
| `HEARTBEAT.md` | Periodic self-check schedule and health definitions |

`loadIdentityFiles()` reads from `preloaded` identity data (sent via stdin payload from DocumentStore). Falls back to filesystem `agentDir` if preloaded data unavailable. Returns empty strings for missing files (never throws).

## Runner Variants

### pi-coding-agent (`pi-session.ts`)

Uses `createAgentSession()` from `@mariozechner/pi-coding-agent`. Two LLM transport modes:
- **Proxy mode** (if `--proxy-socket`): Direct Anthropic SDK calls, credentials injected by proxy
- **IPC mode**: LLM calls route through host via IPC (no credentials in container)

All tools (including bash/file ops) route through IPC to the host. Passes `compactHistory()` if history exceeds 75% of context window.

### claude-code (`claude-code.ts`)

Uses `query()` from `@anthropic-ai/claude-agent-sdk`. Creates:
1. TCP bridge (localhost:PORT -> Unix socket forwarder)
2. In-process MCP server wrapping IPC tools
3. Agent SDK query with system prompt and MCP server
4. Streams output to stdout

Supports inline image blocks via `buildSDKPrompt()` which returns either a plain string or an `AsyncIterable<SDKUserMessage>` with structured content blocks.

## Common Tasks

**Adding a new tool:**
1. Add spec to `TOOL_CATALOG` in `src/agent/tool-catalog.ts` with TypeBox parameters
2. Add category and optional fields (`injectUserId`, `timeoutMs`)
3. For pi-session: add tool object to array in `src/agent/ipc-tools.ts`
4. For claude-code: add MCP tool definition in `src/agent/mcp-server.ts` using Zod
5. Add Zod schema in `src/ipc-schemas.ts` with `.strict()`
6. Add handler in `src/host/ipc-server.ts`
7. Verify tool filtering logic in `src/agent/tool-catalog.ts` (`filterTools`) if the tool should be context-dependent

**Adding a new prompt module:**
1. Create `src/agent/prompt/modules/<name>.ts` implementing `PromptModule` (extend `BasePromptModule`)
2. Register in `PromptBuilder` constructor (`src/agent/prompt/builder.ts`)
3. Set `priority` to control ordering (0-100)
4. Implement `shouldInclude(ctx)` to conditionally include the module
5. Implement `render(ctx)` and optionally `renderMinimal(ctx)`
6. Add test in `tests/agent/prompt/modules/`
7. If the module should affect tool availability, update `ToolFilterContext` logic in `buildSystemPrompt()` and `filterTools()`

**Adding a sandbox tool (bash/file ops):**
1. Add tool spec to `TOOL_CATALOG` in `src/agent/tool-catalog.ts` with `category: 'sandbox'` and `singletonAction: 'sandbox_<name>'`
2. Add Zod schema in `src/ipc-schemas.ts` with `ipcAction('sandbox_<name>', {...})`
3. Add handler in `src/host/ipc-handlers/sandbox-tools.ts` using `safePath()` for file access
4. Add MCP tool definition in `src/agent/mcp-server.ts` (Zod-based)
5. Add test in `tests/host/ipc-handlers/sandbox-tools.test.ts`

## Gotchas

- **Tool filtering is automatic**: `buildSystemPrompt()` returns a `ToolFilterContext` that both runners use to filter the catalog. Excluded prompt modules automatically exclude corresponding tools.
- **Dual tool registration**: IPC tools MUST be registered in BOTH `ipc-tools.ts` (TypeBox) AND `mcp-server.ts` (Zod). Missing one means that runner type has no access to the tool. Ensure parameter names match via sync tests.
- **Image blocks in IPC transport**: `createIPCStreamFn()` accepts optional `imageBlocks` and injects them into the last plain-text user message. Both `type: 'image'` (fileId) and `type: 'image_data'` (base64) are supported.
- **Heartbeat keep-alive**: IPC calls reset their timeout on each heartbeat frame. Don't ignore `_heartbeat` frames in response parsing.
- **LLM calls never go direct**: All LLM calls route through either the proxy (Anthropic SDK over Unix socket) or IPC. The agent has no API keys.
- **TypeBox for tool params, Zod for IPC schemas**: Don't mix them. Tools use `Type.Object(...)`, IPC uses `z.strictObject(...)`.
- **`safePath()` is mandatory**: Every sandbox tool file operation must go through `safePath()` to prevent workspace escape. Sandbox tools now route through IPC to host-side handlers in `src/host/ipc-handlers/sandbox-tools.ts`.
- **Strict IPC schemas reject unknown fields**: Adding a field to an IPC call without updating the Zod schema silently fails (`{ok: false}`).
- **Identity loader never throws**: Missing files return `''`. Check content length, not for exceptions.
- **Identity/skills via stdin payload**: The host loads identity and skills from DocumentStore and sends them in the stdin JSON payload. The agent no longer reads identity/skills from filesystem mounts.
- **Context-aware tool filtering**: Excluded prompt modules must have corresponding category filters in `filterTools()`.
- **Delegation module**: Priority 75, optional, excluded during bootstrap. Includes guidance on `agent_delegate` and runner selection.
