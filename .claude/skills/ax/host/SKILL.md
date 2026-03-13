---
name: host
description: Use when modifying the trusted host process — server orchestration, message routing, IPC handler, request lifecycle, event streaming, file handling, plugin loading, or agent delegation in src/host/
---

## Overview

The host subsystem is the trusted half of AX. It runs the HTTP server (OpenAI-compatible API over Unix socket and optional TCP), routes inbound/outbound messages through security scanning and taint tracking, dispatches IPC actions from sandboxed agents to provider implementations, manages the agent process lifecycle (spawn, stdin, stdout, cleanup), streams real-time completion events via SSE, handles file uploads/downloads, loads third-party plugin providers, and orchestrates sub-agent delegation with depth/concurrency limits.

## Key Files

| File | Responsibility |
|---|---|
| `src/host/server.ts` | HTTP server, request lifecycle, agent spawn, channel/scheduler wiring, file handlers, SSE events, port flag |
| `src/host/server-completions.ts` | Completion processing, workspace setup, history loading, image extraction, agent spawning, response parsing |
| `src/host/server-channels.ts` | Channel ingestion, message deduplication, thread gating/backfill, emoji reactions, attachment handling |
| `src/host/server-files.ts` | File upload/download API, workspace file storage, MIME type handling |
| `src/host/server-http.ts` | HTTP utilities, SSE chunking, body reading, error responses |
| `src/host/server-lifecycle.ts` | Workspace cleanup, graceful shutdown, stale session cleanup |
| `src/host/event-bus.ts` | Typed pub/sub for real-time completion observability, global + per-request listeners |
| `src/host/router.ts` | Inbound scan + taint-wrap + canary inject; outbound scan + canary check |
| `src/host/ipc-server.ts` | Unix socket server, IPC action dispatch, Zod validation, taint budget gate, heartbeat, event emission |
| `src/host/ipc-handlers/browser.ts` | Browser automation IPC handlers |
| `src/host/ipc-handlers/delegation.ts` | Agent delegation with depth/concurrency limits, zombie counter prevention |
| `src/host/ipc-handlers/governance.ts` | Proposal list/review IPC handlers |
| `src/host/ipc-handlers/identity.ts` | Identity read/write/propose IPC handlers (backed by DocumentStore) |
| `src/host/ipc-handlers/image.ts` | Image generation handler, in-memory image storage per session |
| `src/host/ipc-handlers/llm.ts` | LLM call IPC handler with event emission |
| `src/host/ipc-handlers/memory.ts` | Memory CRUD IPC handlers |
| `src/host/ipc-handlers/orchestration.ts` | Agent orchestration IPC handlers (status, list, tree, message, poll, interrupt, timeline) |
| `src/host/ipc-handlers/plugin.ts` | Plugin status/list queries (host-internal actions) |
| `src/host/ipc-handlers/scheduler.ts` | Scheduler job management IPC handlers |
| `src/host/ipc-handlers/skills.ts` | Skill read/list/propose/import/search IPC handlers (backed by DocumentStore) |
| `src/host/ipc-handlers/web.ts` | Web fetch/search IPC handlers |
| `src/host/ipc-handlers/workspace.ts` | Workspace read/write/list IPC handlers |
| `src/host/agent-registry.ts` | Enterprise agent registry (registry.json), lifecycle management |
| `src/host/agent-registry-db.ts` | Database-backed agent registry for PostgreSQL (Kysely, runs own migration) |
| `src/host/server-admin.ts` | Admin API endpoints (agent management, config, diagnostics) |
| `src/host/nats-llm-proxy.ts` | NATS-based LLM proxy for claude-code in k8s — proxies requests to Anthropic API with credential injection |
| `src/host/nats-sandbox-dispatch.ts` | NATS-based sandbox tool dispatch — routes tool calls to remote sandbox pods via request/reply |
| `src/host/nats-session-protocol.ts` | NATS session protocol for k8s sandbox coordination |
| `src/host/delivery.ts` | Delivery resolution for cron/heartbeat responses (CronDelivery handling) |
| `src/host/event-console.ts` | Real-time event display with color-coded output |
| `src/host/history-summarizer.ts` | Recursive conversation summarization with LLM |
| `src/host/memory-recall.ts` | Memory recall integration with embeddings for context injection |
| `src/host/oauth.ts` | OAuth token management (pre-flight + reactive 401 retry) |
| `src/host/server-webhooks.ts` | Inbound webhook handler with LLM-powered transforms |
| `src/host/webhook-transform.ts` | LLM-powered webhook payload transformation |
| `src/host/plugin-host.ts` | Plugin lifecycle manager, integrity verification, process management, IPC proxy |
| `src/host/plugin-lock.ts` | Plugin manifest pinning, SHA-512 integrity hashing, lock file I/O |
| `src/host/plugin-manifest.ts` | Plugin capability schema, validation, human-readable formatting |
| `src/host/proxy.ts` | Credential-injecting Anthropic forward proxy, OAuth 401 retry |
| `src/host/taint-budget.ts` | Per-session taint ratio tracking, action gating (SC-SEC-003) |
| `src/host/provider-map.ts` | Static allowlist mapping config names to provider modules (SC-SEC-002), plugin registration runtime allowlist |
| `src/host/registry.ts` | Loads and assembles ProviderRegistry from config; three loading patterns (simple, manual-import with deps, custom); plugin host integration |

## Request Lifecycle (server.ts + server-completions.ts)

### HTTP Completion Request

1. **HTTP Handler** -- Parse OpenAIChatRequest JSON, validate session_id, derive stable session ID (explicit -> user field -> random UUID), extract user/conversationId
2. **Router + Inbound Scan** -- Build InboundMessage, call `router.processInbound()` (scan, taint-wrap, canary inject, enqueue), emit `completion.start` and `scan.inbound` events
3. **Message Dequeue** -- Dequeue **by ID** (not FIFO) from MessageQueue
4. **Workspace Setup** -- Create workspace dir, load identity/skills from DocumentStore, build conversation history (DB-persisted for persistent sessions, client-provided for ephemeral), prepend parent channel context for thread sessions
5. **Credential Proxy** (claude-code only) -- Refresh OAuth pre-flight, start Anthropic credential-injecting proxy, pass proxy socket to agent
6. **Agent Spawn** -- Build spawn command with runner args, spawn with stdio pipes, write JSON payload to stdin (history, message, taintRatio, profile, requestId, identity, skills), collect stdout/stderr concurrently
7. **Outbound Scanning + Response Processing** -- Call `router.processOutbound()`, parse agent response (structured JSON with __ax_response or plain text), extract image_data blocks -> save to workspace/files/ -> convert to file refs, drain generated images
8. **Persistence + Cleanup** -- Persist conversation turns, attach file refs, clean up workspace/proxy, emit `completion.done` event

### Channel Message Ingestion (server-channels.ts)

1. **Deduplication**: TTL-based `processedMessages` map keyed by `channelName:messageId`
2. **Thread Gating**: Threads only processed if SOUL.md exists
3. **Thread Backfill**: Fetch parent message + thread root, build context
4. **Bootstrap Gate**: Require admin claim and IDENTITY.md before processing
5. **Attachment Handling**: Download image attachments, embed as `image_data` content blocks (no disk round-trip)
6. **processCompletion Call**: Pass preprocessed message, userId, replyOptional flag
7. **Outbound**: Upload generated images + file refs to channel

## Event Bus (event-bus.ts)

Typed pub/sub for real-time completion observability.

- **Synchronous emit** (fire-and-forget) -- never blocks the hot path
- **Global listeners**: receive all events (max 100)
- **Per-request listeners**: scoped to requestId (max 50 per request)
- **Event types**: dot-namespaced (e.g. `completion.start`, `llm.done`, `scan.inbound`)
- **No secrets**: event.data never contains credentials or sensitive info
- **SSE endpoint**: `GET /v1/events?request_id=...&types=...` with 15s keepalive

## File Storage (server-files.ts)

- **Endpoints**: `POST /v1/files?agent=<name>&user=<id>` (upload), `GET /v1/files/<fileId>?agent=<name>&user=<id>` (download)
- **Storage**: `~/.ax/agents/<name>/workspaces/<userId>/files/<fileId>`
- **MIME types**: `image/png`, `image/jpeg`, `image/gif`, `image/webp` (10 MB max)
- **FileStore**: metadata registry (fileId -> agentName, userId) for lookups without query params

## IPC Server (ipc-server.ts)

**Protocol**: 4-byte big-endian length prefix + JSON over Unix socket.

**Dispatch pipeline**:
1. Parse JSON
2. Validate envelope schema (`IPCEnvelopeSchema`)
3. Validate action-specific Zod schema (`.strict()` mode)
4. **Step 3.5**: Taint budget check -- hard-blocks tainted sessions (except `identity_write`, `user_write`, `identity_propose`)
5. Dispatch to handler function, audit log result

**Heartbeat frames**: Long-running handlers emit `{_heartbeat: true, ts}` every 15s to prevent client timeout.

**Event emission**: Handlers emit events via `eventBus` (e.g., `llm.start`, `llm.done`) for streaming observability.

## Plugin System

### Plugin Manifest (plugin-manifest.ts)
- Schema validation: name, kind (llm/image/memory/etc.), capabilities
- Capabilities: network (host:port endpoints), filesystem (none/read/write), credentials (injected keys)
- No wildcards, explicit declarations only

### Plugin Lock File (plugin-lock.ts)
- `~/.ax/plugins.lock` -- JSON file pinning exact versions and SHA-512 hashes
- On every startup, hashes verified before plugin loads

### Plugin Host (plugin-host.ts)
- **Lifecycle**: startAll() -> spawn workers -> verify integrity -> register providers
- **Worker Process**: fork() with restricted environment (no credentials, minimal env vars)
- **IPC Protocol**: plugin_call -> plugin_response
- **Credential Injection**: server-side resolver (plugin never sees credential store)
- **Timeouts**: startup (10s), call (30s)
- **Graceful Shutdown**: send plugin_shutdown, wait 5s, force-kill

### Provider Map (provider-map.ts)
- **Built-in Allowlist** (`_PROVIDER_MAP`): static mapping of (kind, name) -> relative/package paths
- **Plugin Registration**: runtime allowlist (`_pluginProviderMap`) for Phase 3 plugins
- **URL Scheme Guard**: post-resolution check ensures all paths are file:// URLs (SC-SEC-002)
- Functions: `resolveProviderPath()`, `registerPluginProvider()`, `unregisterPluginProvider()`, `listPluginProviders()`

## Image Generation (ipc-handlers/image.ts)

- **Handler**: `image_generate` IPC action
- **Storage**: Generated images held in-memory per session in `pendingImages` map
- **Lifetime**: After agent finishes, `drainGeneratedImages(sessionId)` retrieves all images for channel upload + history persistence

## Agent Delegation (ipc-handlers/delegation.ts)

- **Handler**: `agent_delegate` IPC action
- **Depth Tracking**: stored in `agentId` (e.g., `delegate-foo:depth=1`)
- **Limits**: maxDepth (default 2), maxConcurrent (default 3)
- **Zombie Counter Prevention**: `activeDelegations++` before any await, decremented in finally block
- **Config Override**: optional runner/model/maxTokens/timeoutSec passed to processCompletion

## Orchestration Subsystem (src/host/orchestration/)

Multi-agent orchestration for parent-child delegation with lifecycle management:

- **`orchestrator.ts`** -- Main orchestration engine, coordinates agent delegation and collection
- **`agent-loop.ts`** -- Core agent execution loop
- **`agent-supervisor.ts`** -- Agent lifecycle supervision and recovery
- **`agent-directory.ts`** -- Active agent registration and lookup
- **`heartbeat-monitor.ts`** -- Liveness detection for child agents
- **`event-store.ts`** -- Audit trail for orchestration events
- **`types.ts`** -- Orchestration types (AgentHandle, etc.)

Key IPC actions: `agent_orch_status`, `agent_orch_list`, `agent_orch_tree`, `agent_orch_message`, `agent_orch_poll`, `agent_orch_interrupt`, `agent_orch_timeline`.

## History Summarization & Memory Recall

- **`history-summarizer.ts`** -- Recursive conversation summarization via LLM. Enables infinite-length conversations by condensing older turns.
- **`memory-recall.ts`** -- Semantic embedding-based memory retrieval. Injects relevant memories into conversation context via `src/utils/embedding-client.ts`.

## Webhooks (server-webhooks.ts + webhook-transform.ts)

- **Inbound webhooks:** `POST /v1/webhooks` endpoint for external event ingestion
- **LLM-powered transforms:** Markdown-based transform definitions convert external payloads to agent prompts
- **Configurable:** Optional `agentId`, `sessionKey`, `model`, `timeoutSec` fields per transform
- **Config:** `config.webhooks` with `enabled`, `token`, `path`, `max_body_bytes`, `model`, `allowed_agent_ids`

## Router (router.ts)

- **`processInbound(msg)`**: Canonicalizes session ID, generates canary token, wraps content in `<external_content>` taint tags, records in taint budget, runs `scanner.scanInput()`, enqueues with canary appended. Returns `RouterResult` with `queued`, `messageId`, `canaryToken`.
- **`processOutbound(response, sessionId, canaryToken)`**: Checks canary leakage, scans output, strips canary. Redacts entire response if canary leaked.

## NATS Subsystem (K8s Deployment)

For Kubernetes deployments, several NATS-based components handle communication between the host and sandbox pods:

- **`nats-llm-proxy.ts`** — Subscribes to `ipc.llm.{sessionId}`, proxies LLM requests to Anthropic API with credential injection. Allows claude-code pods to make LLM calls without API keys.
- **`nats-sandbox-dispatch.ts`** — Dispatches tool calls (bash, read_file, write_file, edit_file) to sandbox worker pods via NATS request/reply. Per-turn pod affinity: first call claims a warm pod, subsequent calls reuse it.
- **`nats-session-protocol.ts`** — Session coordination protocol for k8s sandbox.

## Agent Registry

- **`agent-registry.ts`** — In-memory/file-based agent registry (`registry.json`) for single-server deployments.
- **`agent-registry-db.ts`** — Database-backed registry for PostgreSQL (k8s). Runs its own Kysely migration (`registry_001_agent_registry`). Stores agent metadata: id, name, description, status, parent_id, agent_type, capabilities.

## Admin API (`server-admin.ts`)

Admin endpoints for agent management and diagnostics. Protected by admin token (logged at startup for pod retrieval).

## Common Tasks

**Adding a new HTTP endpoint:**
1. Add URL match in `handleRequest()` in `server.ts`
2. Create handler function (follow existing patterns)
3. Return JSON with `Content-Length` header
4. For streaming endpoints, use SSE format (handleEvents pattern)

**Adding a new IPC action handler:**
1. Add Zod schema in `src/ipc-schemas.ts` (`.strict()`)
2. Add handler in domain module (e.g., `createLLMHandlers`)
3. Register tool in `src/agent/ipc-tools.ts` AND `src/agent/mcp-server.ts`
4. Update tool count in `tests/sandbox-isolation.test.ts`
5. If handler emits events, add event types to event bus

**Adding streaming events:**
1. Emit via `eventBus.emit()` in completion/agent/provider paths
2. Use dot-namespaced event type (e.g., `llm.token_delta`)
3. Include requestId for per-request filtering
4. Never include secrets in event.data

## Gotchas

- **Dequeue by ID, not FIFO**: FIFO dequeue causes session ID mismatches and empty canary tokens.
- **Consumed response body in proxy retry**: After reading body for 401 check, original response is consumed. Retry must use new response.
- **Pino uses underscore keys**: `logger.info('server_listening')` not `'server listening'`.
- **identity_write / user_write / identity_propose skip global taint gate**: These do soft queuing in their handlers.
- **Collect stdout/stderr in parallel**: Sequential collection deadlocks when one pipe buffer fills.
- **Channel deduplication**: TTL-based `processedMessages` map keyed by `channelName:messageId`.
- **Extract image_data blocks immediately**: image_data blocks are transient -- must never be stored in conversation store. `extractImageDataBlocks()` is the single conversion point.
- **Event emission is synchronous**: Emits never await or throw.
- **Plugin integrity verified on startup**: verifyPluginIntegrity() called before PluginHost registers.
- **Zombie counter in delegation**: Always wrap activeDelegations mutation in try/finally.
- **Request-scoped _sessionId for images**: Stripped before schema validation.
- **SSE keepalive**: handleEvents sends `:keepalive\n\n` every 15s.
- **Port flag support**: `--port <number>` listens on TCP instead of Unix socket.
