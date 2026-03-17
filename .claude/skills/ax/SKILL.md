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
| `k8s` | Kubernetes | **NATS** | Pods with NATS-based IPC |

Old Linux-specific sandbox providers (seatbelt, nsjail, bwrap) have been removed. The k8s provider uses NATS for all host-agent communication (IPC request/reply, LLM proxy, event streaming) instead of Unix sockets, since pods cannot share a filesystem with the host.

**Outbound HTTP via Web Proxy**: Agents can optionally make outbound HTTP/HTTPS requests (npm install, pip install, curl, git clone) through a controlled forward proxy on the host. Opt-in via `config.web_proxy` (disabled by default). Containers keep `--network=none` — agents reach the proxy via a TCP bridge over a mounted Unix socket. The proxy enforces private IP blocking (SSRF), canary token scanning, and audit logging. K8s pods connect directly via a k8s Service (`ax-web-proxy`).

### NATS in k8s Deployments

In k8s mode, NATS is the backbone for all cross-pod communication:
- **IPC**: `src/host/nats-ipc-handler.ts` and `src/agent/nats-ipc-client.ts`
- **LLM proxy**: `src/host/nats-llm-proxy.ts`
- **Event bus**: `src/providers/eventbus/nats.ts`
- **Work dispatch**: Host publishes work to `agent.work.{podName}` via NATS

All NATS callers use `natsConnectOptions()` from `src/utils/nats.ts` for consistent server URL, authentication (NATS_USER/NATS_PASS), and reconnect configuration.

### Workspace Provider (Recent Addition)

The workspace provider (`src/providers/workspace/`) manages persistent file workspaces for agent sessions across three scopes: agent, user, and session. Backends: `none` (no-op), `local` (filesystem), `gcs` (Google Cloud Storage). Loaded as part of the standard registry chain in `src/host/registry.ts`.

### Provider Categories

There are 17 provider categories in the static allowlist (`src/host/provider-map.ts`): llm, image, memory, scanner, channel, web, browser, credentials, skills, audit, sandbox, scheduler, screener, database, storage, eventbus, workspace.
