---
name: ax
description: AX project architecture and coding skills - use sub-skills for specific subsystems (agent, host, cli, providers, etc.)
---

## AX Project Skills

This is the parent skill group for all AX project-specific architecture and coding skills. Use the appropriate sub-skill for the subsystem you're working on.

- **Core**: ax-agent, ax-host, ax-cli, ax-config, ax-ipc, ax-runners, ax-utils
- **Providers**: ax-provider-audit, ax-provider-channel, ax-provider-credentials, ax-provider-database, ax-provider-development, ax-provider-eventbus, ax-provider-llm, ax-provider-memory, ax-provider-sandbox, ax-provider-scheduler, ax-provider-skills, ax-provider-storage, ax-provider-system, ax-provider-web
- **Cross-cutting**: ax-security, ax-testing, ax-logging-errors, ax-persistence, ax-prompt-builder, ax-onboarding
- **UI**: ax-admin-dashboard-ui

## Architecture at a Glance

AX uses a **provider contract pattern**. The trusted host process (`src/host/`) orchestrates sandboxed agent processes (`src/agent/`) via IPC, with a plugin system (`src/plugins/`) for extensibility. Every subsystem is a TypeScript interface with pluggable implementations, loaded from a static allowlist in `src/host/provider-map.ts` (SC-SEC-002).

### Sandbox Model

Agent isolation uses a unified container model with three sandbox providers:

| Provider | Platform | IPC Transport | Notes |
|----------|----------|---------------|-------|
| `docker` | Any | Unix socket | Container isolation via Docker |
| `apple` | macOS | Unix socket (reverse bridge) | Apple Container framework |
| `k8s` | Kubernetes | **HTTP** (IPC + work dispatch) | Session-long pods with HTTP-based IPC |

Old Linux-specific sandbox providers (seatbelt, nsjail, bwrap) and the subprocess dev fallback have been removed. The k8s provider uses HTTP for all communication — IPC (`HttpIPCClient` → `POST /internal/ipc`) and work dispatch (`GET /internal/work`). Session-long pods are managed by `SessionPodManager` and reused across turns. Pods cannot share a filesystem with the host.

**Outbound HTTP via Web Proxy**: Agents can optionally make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) through a controlled forward proxy on the host. Opt-in via `config.web_proxy` (disabled by default). Containers keep `--network=none` — agents reach the proxy via a TCP bridge over a mounted Unix socket. The proxy enforces private IP blocking (SSRF), canary token scanning, and audit logging. K8s pods connect directly via a k8s Service (`ax-web-proxy`).

### HTTP in k8s Deployments

In k8s mode, all communication uses HTTP:
- **IPC**: `src/agent/http-ipc-client.ts` → `POST /internal/ipc` route on host (`src/host/server-k8s.ts`)
- **LLM proxy**: `src/host/llm-proxy-core.ts` → `/internal/llm-proxy` HTTP route
- **Work dispatch**: Host queues work via `SessionPodManager.queueWork()`; pods fetch via `GET /internal/work`
- **Event bus**: `src/providers/eventbus/postgres.ts` (PostgreSQL-backed pub/sub for events)

**HTTP for all payloads**: IPC requests use HTTP POST to `/internal/ipc`. Work dispatch uses `SessionPodManager` (in-process queue). NetworkPolicy allows sandbox pods egress to host on port 8080. Workspace persistence uses git-based providers (git-http for k8s, git-local for local dev).

### MCP Fast Path (In-Process Agent)

The MCP fast path (`src/host/inprocess.ts`) runs the LLM orchestration loop directly in the host process — no pods, no IPC, no proxy, no GCS sync. Used for lightweight tool-calling tasks via MCP providers (database-backed). Key files: `inprocess.ts` (LLM loop), `tool-router.ts` (tool routing with per-turn limits), `sandbox-manager.ts` (cross-turn sandbox escalation). See `src/providers/mcp/` for the `McpProvider` interface: `listTools()`, `callTool()`, `credentialStatus()`, `storeCredential()`. Implementations: `none` (no-op), `database` (per-agent HTTP/SSE MCP servers stored in DB with circuit breakers). Unified MCP routing via `McpConnectionManager` (`src/plugins/mcp-manager.ts`).

### Cowork Plugin System

The Cowork plugin system (`src/plugins/`) provides per-agent plugin lifecycle management with MCP server integration. Plugins are installed from GitHub, local directories, or URLs and can declare skills, commands, and MCP servers.

Key files:
- `src/plugins/types.ts` — Plugin manifest, skill, command, MCP server type definitions
- `src/plugins/mcp-manager.ts` — `McpConnectionManager`: unified MCP tool discovery and routing across plugins, database, and default providers
- `src/plugins/mcp-client.ts` — HTTP client for querying remote MCP servers
- `src/plugins/store.ts` — Plugin CRUD via DocumentStore
- `src/plugins/install.ts` — Plugin install/uninstall with MCP server registration
- `src/plugins/startup.ts` — Bootstrap plugin MCP servers from DB and config on startup
- `src/plugins/fetcher.ts` — Fetch plugin files from GitHub, local paths, or URLs
- `src/plugins/parser.ts` — Parse plugin bundles (plugin.json, skills/, commands/, .mcp.json)

Plugin IPC actions: `plugin_install_cowork`, `plugin_uninstall_cowork`, `plugin_list_cowork`. CLI: `ax plugin install|remove|list`.

### Cap'n Web Tool Batching

Zero-dependency TypeScript tool stub generation with Proxy-based batching (`src/host/toolgen/`). Generates per-agent TypeScript stubs cached in DocumentStore with schema hash invalidation.

- `src/host/toolgen/codegen.ts` — TypeScript stub generation (JSON Schema to TypeScript via `json-schema-to-typescript`)
- `src/host/toolgen/generate-and-cache.ts` — DB caching with schema hash for generated stubs
- `src/host/ipc-handlers/tool-batch.ts` — IPC handler for `tool_batch` with `__batchRef` pipelining
- `src/providers/storage/tool-stubs.ts` — Schema hash computation and cache storage

### Provider Categories

There are 15 provider categories in the static allowlist (`src/host/provider-map.ts`): llm, memory, channel, web_fetch, web_extract, web_search, credentials, audit, sandbox, scheduler, database, storage, eventbus, workspace, mcp, auth. Credentials is database-only. Workspace has `git-http` and `git-local` implementations. The `mcp` category has `none` and `database` implementations.
