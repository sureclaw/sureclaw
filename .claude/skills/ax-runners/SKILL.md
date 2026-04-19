---
name: ax-runners
description: Use when modifying agent runner implementations — pi-session (pi-coding-agent), claude-code (Agent SDK), LLM transport selection, MCP tool wiring, or stream handling in src/agent/runners/
---

## Overview

AX supports multiple agent runners that execute inside the sandbox. Each runner wires up LLM communication, tool registration, and output streaming differently. The entry point `runner.ts` dispatches to the appropriate runner based on config. All runners share common infrastructure: IPC client (via `IIPCClient` interface), identity loading, prompt building, tool catalog with context-aware filtering, and stream utilities.

## Key Files

| File | Responsibility | Key Exports |
|---|---|---|
| `src/agent/runner.ts` | Entry point, stdin parse, dispatch, IIPCClient interface | `run()`, `parseStdinPayload()`, `compactHistory()`, `AgentConfig`, `IIPCClient` |
| `src/agent/runners/pi-session.ts` | pi-coding-agent runner (history-aware, dual LLM transport) | `runPiSession()` |
| `src/agent/runners/claude-code.ts` | Claude Agent SDK runner (TCP bridge, MCP tools) | `runClaudeCode()`, `buildSDKPrompt()` |
| `src/agent/mcp-server.ts` | MCP tool registry for claude-code | `createIPCMcpServer()` |
| `src/agent/tcp-bridge.ts` | HTTP-to-Unix-socket forwarder | `startTCPBridge()`, `TCPBridge` |
| `src/agent/web-proxy-bridge.ts` | TCP-to-Unix-socket bridge for HTTP forward proxy (HTTP + CONNECT) | `startWebProxyBridge()`, `WebProxyBridge` |
| `src/agent/http-ipc-client.ts` | HTTP-based IPC client for k8s (drop-in IPCClient replacement) | `HttpIPCClient` |
| `src/agent/skill-installer.ts` | Skill dependency installer — reads SKILL.md install specs, runs missing installs | `installSkillDeps()` |
| `src/agent/git-cli.ts` | Native git CLI wrapper (no shell, execFile) | `gitExec()`, `gitClone()`, `gitCommit()`, `gitPush()`, `GitOpts` |
| `src/agent/git-sidecar.ts` | K8s git sidecar HTTP server (POST /pull, /turn-complete) | `startGitSidecar()` |
| `src/agent/git-workspace.ts` | Agent-side git workspace (clone, pull, commit+push) | `GitWorkspace` |
| `src/agent/local-sandbox.ts` | Agent-side sandbox execution with host audit gate | `createLocalSandbox()` |
| `src/agent/stream-utils.ts` | Message conversion, stream events, helpers | `convertPiMessages()`, `emitStreamEvents()`, `createSocketFetch()`, `createLazyAnthropicClient()` |
| `src/agent/ipc-transport.ts` | IPC-based LLM streaming adapter with image block injection | `createIPCStreamFn()` |
| `src/agent/tool-catalog.ts` | Single source of truth for tool metadata and context-aware filtering | `TOOL_CATALOG`, `filterTools()`, `ToolFilterContext` |
| `src/agent/identity-loader.ts` | Loads identity files from preloaded stdin payload (or filesystem fallback) | `loadIdentityFiles()` |

## IIPCClient Interface

Both runners use the `IIPCClient` interface (defined in `src/agent/runner.ts`) instead of the concrete `IPCClient` class. This enables transport-agnostic IPC:

```typescript
interface IIPCClient {
  call(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  connect(): Promise<void>;
  disconnect(): void;
  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string; token?: string }): void;
}
```

Implementations: `IPCClient` (Unix socket), `HttpIPCClient` (HTTP for k8s). A pre-connected client can be passed via `AgentConfig.ipcClient` for listen and HTTP modes.

## Three IPC Transport Modes

`runner.ts` selects the IPC transport based on environment variables:

| Mode | Env Trigger | Client | Subject/Path | Use Case |
|---|---|---|---|---|
| **Socket** (default) | No special env | `IPCClient` | Unix socket via `--ipc-socket` | Local/subprocess sandbox |
| **HTTP** | `AX_HOST_URL` set | `HttpIPCClient` | HTTP POST to `/internal/ipc` | Kubernetes pods |
| **Listen** | `AX_IPC_LISTEN=1` | `IPCClient` (listen mode) | Unix socket (reverse -- agent listens) | Apple Container sandbox |

In HTTP and Listen modes, the client is created and connected before stdin/work-payload is read, then passed via `AgentConfig.ipcClient`.

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
1. Use pre-connected `IIPCClient` from `config.ipcClient` (or create new `IPCClient`)
2. Start web proxy bridge if `AX_WEB_PROXY_SOCKET` / `AX_WEB_PROXY_URL` / `AX_WEB_PROXY_PORT` env var set; set `HTTP_PROXY`/`HTTPS_PROXY` for child processes
2b. If `WORKSPACE_REPO_URL` set: clone workspace via `GitWorkspace` (non-k8s) or signal git sidecar via HTTP POST `/pull` (k8s)
3. Create LLM stream function (proxy preferred, IPC fallback)
4. Load identity files, build system prompt via `buildSystemPrompt()` (returns prompt + `ToolFilterContext`)
5. Create IPC tools (filtered by `ToolFilterContext` -- memory, web, audit, skills, scheduler, identity/user write, delegation, image_generate)
6. Load + compact conversation history from stdin (75% context window threshold)
7. Create `AgentSession` with tools, history, custom system prompt
8. Call `session.sendMessage(userMessage)` and stream text to stdout
9. Subscribe to events: text_delta -> stdout, tool calls -> logged
10. At turn end: commit and push workspace changes via `gitWorkspace.commitAndPush()` or POST `/turn-complete` to sidecar

**Timeout passthrough**: `LLM_CALL_TIMEOUT_MS` (configurable via `AX_LLM_TIMEOUT_MS`, defaults to 10 min) passed to IPC calls.

**Tools**: Defined as pi-ai `ToolDefinition` objects using TypeBox schemas in `ipc-tools.ts`.

## claude-code Runner

**Architecture**: TCP bridge + IPC MCP server + Agent SDK query.

**Key flow:**
1. Start bridge: TCP bridge (`startTCPBridge(proxySocket)`) for credential-injecting proxy
1b. Start web proxy bridge if `AX_WEB_PROXY_SOCKET` / `AX_WEB_PROXY_URL` / `AX_WEB_PROXY_PORT` env var set
1c. If `WORKSPACE_REPO_URL` set: clone workspace via `GitWorkspace` (non-k8s) or POST `/pull` to git sidecar (k8s)
2. Use pre-connected `IIPCClient` from `config.ipcClient` (or create new `IPCClient`)
3. Create IPC MCP server (`createIPCMcpServer(client)`) exposing tools via MCP protocol
4. Build system prompt via `buildSystemPrompt()` (returns prompt + `ToolFilterContext`)
5. Call `query()` from Claude Agent SDK with:
   - `systemPrompt`: built prompt
   - `maxTurns: 20`
   - `ANTHROPIC_BASE_URL`: `http://127.0.0.1:${bridge.port}` (TCP bridge)
   - `disallowedTools`: `['WebFetch', 'WebSearch', 'Skill']` (use AX's IPC versions)
   - `mcpServers`: the IPC MCP server
   - `env`: includes `HTTP_PROXY`/`HTTPS_PROXY` if web proxy bridge is running
6. Stream text blocks to stdout
7. At turn end: commit and push workspace changes via git

**Image support via `buildSDKPrompt()`**: When the user message contains `image_data` content blocks, `buildSDKPrompt()` returns an `AsyncIterable<SDKUserMessage>` with structured content blocks (text + base64 images) instead of a plain string.

**TCP Bridge** (`tcp-bridge.ts`): HTTP server on localhost:0 forwarding to Unix socket proxy. Strips encoding headers. Used for local deployments.

**MCP Server** (`mcp-server.ts`): Agent SDK MCP server exposing IPC tools as Zod-based tool definitions. Includes: memory_*, web_*, audit_query, identity_write, user_write, scheduler_*, skill_propose, request_credential (standalone, always available), agent_delegate, image_generate, sandbox_bash, sandbox_read_file, sandbox_write_file, sandbox_edit_file.

## Local Sandbox (Container Mode)

When running inside a container (Docker, Apple Container, k8s), sandbox tools can route to `src/agent/local-sandbox.ts` instead of IPC to the host. The agent executes operations locally with a host audit gate:

1. Agent sends `sandbox_approve` via IPC -- host audits and returns `{approved: true/false}`.
2. If approved, agent executes the operation locally (bash, file read/write/edit) using `createLocalSandbox()`.
3. Agent sends `sandbox_result` to report outcome (best-effort, fire-and-forget).

This avoids the round-trip of sending file contents/command output over IPC for every sandbox operation. The host retains audit control via the approve/result protocol. All file paths are validated with `safePath()` for workspace containment.

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
- **IIPCClient not IPCClient**: Both runners accept `IIPCClient` (the interface), not the concrete `IPCClient`. Always type IPC clients as `IIPCClient` in runner code.
- **Pre-connected client in listen/HTTP modes**: In listen and HTTP transport modes, the IPC client is created and connected in `runner.ts` main block BEFORE stdin is read. Runners should use `config.ipcClient` when available instead of creating a new `IPCClient`.
- **Proxy vs IPC transport**: pi-session prefers proxy (lower latency). claude-code always uses TCP bridge -> proxy. IPC fallback adds serialization overhead.
- **IPC timeout**: Configurable via `AX_LLM_TIMEOUT_MS` env var, defaults to 10 minutes. Long-running agent loops can hit this.
- **`createLazyAnthropicClient` uses `apiKey: 'ax-proxy'`**: Dummy value -- the host proxy injects the real key. Never pass real keys.
- **`convertPiMessages` uses `'.'` for empty content**: Anthropic API rejects empty strings.
- **TCP bridge strips encoding headers**: `transfer-encoding`, `content-encoding`, `content-length` removed.
- **MCP server `stripTaint()`**: Removes `taint` fields from IPC responses before returning to Agent SDK.
- **claude-code disallows WebFetch/WebSearch/Skill**: Replaced by AX's IPC-routed equivalents for taint tracking.
- **Image blocks via `buildSDKPrompt()`**: Structured content blocks only generated when `image_data` blocks are present in user message.
- **Context-aware filtering**: Both runners now use `ToolFilterContext` from `buildSystemPrompt()` to automatically exclude tools based on missing prompt modules.
- **Identity via stdin payload**: The host loads identity from committed git state and sends it in the stdin JSON payload via `loadIdentityFiles({ preloaded: config.identity })`. Skills live in `.ax/skills/` in the git workspace — the agent reads them directly from the filesystem. No DB or payload involvement for skills.
- **No eager skill install**: `installSkillDeps()` is no longer called at runner startup. Skill dependencies are installed lazily when the agent reads a SKILL.md and runs install commands via bash.
- **Concurrent IPC fix**: Misrouted responses on shared Unix sockets have been fixed. Each `call()` is now correctly matched to its response.
- **Web proxy bridge cleanup**: Both runners stop the web proxy bridge in their cleanup path (after agent loop completes). Failure to start the bridge is non-fatal (logged as warning, agent continues without outbound HTTP).
- **Web proxy env var priority**: `AX_WEB_PROXY_SOCKET` (container, Unix socket bridge) > `AX_WEB_PROXY_URL` (k8s, direct URL) > `AX_WEB_PROXY_PORT` (subprocess, TCP). Only one is used.
- **Git workspace integration**: Both runners check `WORKSPACE_REPO_URL` env var. Non-k8s uses `GitWorkspace` directly; k8s signals `git-sidecar.ts` via HTTP (default port 9099, configurable via `AX_GIT_SIDECAR_PORT`).
- **Git sidecar pattern**: In k8s, agent (UID 1000) cannot access `.git/`. Sidecar (UID 1001) owns `.git/` and exposes HTTP API. Prevents agent from tampering with git history.
- **K8s workspace is git-based**: Workspace release via old GCS/staging path has been replaced by git sidecar commit+push. The old `workspace-release.ts` has been deleted.
