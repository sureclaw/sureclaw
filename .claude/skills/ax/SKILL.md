---
name: ax
description: AX project architecture and coding skills - use sub-skills for specific subsystems (agent, host, cli, providers, etc.)
---

## AX Project Skills

This is the parent skill group for all AX project-specific architecture and coding skills. Use the appropriate sub-skill for the subsystem you're working on.

- **Core**: ax-agent, ax-host, ax-cli, ax-config, ax-ipc, ax-runners, ax-utils
- **Providers**: ax-provider-audit, ax-provider-browser, ax-provider-channel, ax-provider-credentials, ax-provider-database, ax-provider-development, ax-provider-eventbus, ax-provider-image, ax-provider-llm, ax-provider-memory, ax-provider-sandbox, ax-provider-scanner, ax-provider-scheduler, ax-provider-screener, ax-provider-skills, ax-provider-storage, ax-provider-system, ax-provider-web
- **Cross-cutting**: ax-security, ax-testing, ax-logging-errors, ax-persistence, ax-prompt-builder, ax-onboarding
- **UI**: ax-admin-dashboard-ui

## Architecture at a Glance

AX uses a **provider contract pattern**. The trusted host process (`src/host/`) orchestrates sandboxed agent processes (`src/agent/`) via IPC. Every subsystem is a TypeScript interface with pluggable implementations, loaded from a static allowlist in `src/host/provider-map.ts` (SC-SEC-002).

### Sandbox Model

Agent isolation uses a unified container model with four sandbox providers:

| Provider | Platform | IPC Transport | Notes |
|----------|----------|---------------|-------|
| `subprocess` | Any | Unix socket | No isolation, dev/test use |
| `docker` | Any | Unix socket | Container isolation via Docker |
| `apple` | macOS | Unix socket (reverse bridge) | Apple Container framework |
| `k8s` | Kubernetes | **HTTP** (IPC + work dispatch) | Session-long pods with HTTP-based IPC |

Old Linux-specific sandbox providers (seatbelt, nsjail, bwrap) have been removed. The k8s provider uses HTTP for all communication — IPC (`HttpIPCClient` → `POST /internal/ipc`) and work dispatch (`GET /internal/work`). Session-long pods are managed by `SessionPodManager` and reused across turns. Pods cannot share a filesystem with the host.

**Outbound HTTP via Web Proxy**: Agents can optionally make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) through a controlled forward proxy on the host. Opt-in via `config.web_proxy` (disabled by default). Containers keep `--network=none` — agents reach the proxy via a TCP bridge over a mounted Unix socket. The proxy enforces private IP blocking (SSRF), canary token scanning, and audit logging. K8s pods connect directly via a k8s Service (`ax-web-proxy`).

### HTTP in k8s Deployments

In k8s mode, all communication uses HTTP:
- **IPC**: `src/agent/http-ipc-client.ts` → `POST /internal/ipc` route on host (`src/host/server-k8s.ts`)
- **LLM proxy**: `src/host/llm-proxy-core.ts` → `/internal/llm-proxy` HTTP route
- **Work dispatch**: Host queues work via `SessionPodManager.queueWork()`; pods fetch via `GET /internal/work`
- **Event bus**: `src/providers/eventbus/nats.ts` (NATS-backed pub/sub for events — only remaining NATS use)

**HTTP for all payloads**: Workspace file data flows via HTTP POST to the host's `/internal/workspace-staging` endpoint. IPC requests use HTTP POST to `/internal/ipc`. Work dispatch uses `SessionPodManager` (in-process queue). NetworkPolicy allows sandbox pods egress to host on port 8080.

### Workspace Provider

The workspace provider (`src/providers/workspace/`) manages persistent file workspaces for agent sessions across three scopes: agent, user, and session. Backends: `none` (no-op), `local` (filesystem), `gcs` (Google Cloud Storage). In k8s mode, workspace changes are synced back to GCS via the HTTP staging + workspace_release IPC flow (see ax-provider-sandbox skill for details). Loaded as part of the standard registry chain in `src/host/registry.ts`.

### MCP Fast Path (In-Process Agent)

The MCP fast path (`src/host/inprocess.ts`) runs the LLM orchestration loop directly in the host process — no pods, no IPC, no proxy, no GCS sync. Used for lightweight tool-calling tasks via MCP providers (e.g., Activepieces). Key files: `inprocess.ts` (LLM loop), `tool-router.ts` (tool routing with per-turn limits), `sandbox-manager.ts` (cross-turn sandbox escalation). See `src/providers/mcp/` for the MCP provider interface (`McpProvider`: `listTools`, `callTool`, `credentialStatus`, `storeCredential`, `listApps`).

### Provider Categories

There are 18 provider categories in the static allowlist (`src/host/provider-map.ts`): llm, image, memory, scanner, channel, web_extract, web_search, browser, credentials, audit, sandbox, scheduler, screener, database, storage, eventbus, workspace, mcp.
