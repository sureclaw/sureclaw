---
name: ax-host
description: Use when modifying the trusted host process — server orchestration, message routing, IPC handler, request lifecycle, event streaming, file handling, plugin loading, or agent delegation in src/host/
---

## Overview

The host subsystem is the trusted half of AX. It runs the HTTP server (OpenAI-compatible API over Unix socket and optional TCP), routes inbound/outbound messages through security scanning and taint tracking, dispatches IPC actions from sandboxed agents to provider implementations, manages the agent process lifecycle (spawn, stdin, stdout, cleanup), streams real-time completion events via SSE, handles file uploads/downloads, loads third-party plugin providers, and orchestrates sub-agent delegation with depth/concurrency limits.

## Key Files

| File | Responsibility |
|---|---|
| `src/host/server-local.ts` | HTTP server composition root (local mode): Unix socket + TCP lifecycle, channel connect/disconnect, legacy migration, file upload/download, OAuth callbacks, graceful drain. Delegates shared init to `server-init.ts` and shared handlers to `server-request-handlers.ts` |
| `src/host/server-init.ts` | Shared initialization for both server-local.ts and server-k8s.ts: `initHostCore()` sets up storage, routing, taint budget, agent dirs, template seeding, skills seeding, admins, IPC, CompletionDeps, delegation, orchestrator, agent registry |
| `src/host/server-request-handlers.ts` | Shared HTTP handlers: `handleModels`, `handleCompletions` (body parsing + streaming + non-streaming via `runCompletion` callback), `handleEventsSSE` (EventBus-based SSE), `createSchedulerCallback` factory |
| `src/host/server-admin-helpers.ts` | Pure admin functions: `isAgentBootstrapMode`, `isAdmin`, `addAdmin`, `claimBootstrapAdmin` (used by server-local.ts, server-completions.ts, IPC handlers) |
| `src/host/server-webhook-admin.ts` | Shared webhook + admin handler factories: `setupWebhookHandler`, `setupAdminHandler` |
| `src/host/server-completions.ts` | Completion processing, workspace setup, history loading, image extraction, agent spawning, response parsing. Container sandboxes (Docker/Apple) use three-phase orchestration: provision (network) → run (no network) → cleanup (network) |
| `src/host/server-channels.ts` | Channel ingestion, message deduplication, thread gating/backfill, emoji reactions, attachment handling |
| `src/host/server-files.ts` | File upload/download API, workspace file storage, MIME type handling |
| `src/host/server-http.ts` | HTTP utilities, SSE chunking, body reading, error responses |
| `src/host/server-lifecycle.ts` | Workspace cleanup, graceful shutdown, stale session cleanup |
| `src/host/event-bus.ts` | Typed pub/sub for real-time completion observability, global + per-request listeners |
| `src/host/router.ts` | Inbound scan + taint-wrap + canary inject; outbound scan + canary check |
| `src/host/ipc-server.ts` | Unix socket server, IPC action dispatch, Zod validation, taint budget gate, heartbeat, event emission. Concurrent IPC call fix (misrouted responses on shared socket). proxy.sock race prevention (await IPC server listen). `agent_response` timeout handling without crashing |
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
| `src/host/ipc-handlers/sandbox-tools.ts` | Sandbox tool IPC handlers (sandbox_bash, sandbox_read_file, sandbox_write_file, sandbox_edit_file) and audit gate protocol (sandbox_approve, sandbox_result) for in-container tool execution with host approval |
| `src/host/ipc-handlers/skills.ts` | Skill read/list/propose/import/search IPC handlers (backed by DocumentStore) |
| `src/host/ipc-handlers/web.ts` | Web fetch/search IPC handlers |
| `src/host/ipc-handlers/workspace.ts` | Workspace read/write/list IPC handlers |
| `src/host/agent-registry.ts` | Enterprise agent registry (registry.json), lifecycle management |
| `src/host/agent-registry-db.ts` | Database-backed agent registry for PostgreSQL (Kysely, runs own migration) |
| `src/host/server-admin.ts` | Admin API endpoints (agent management, config, diagnostics) |
| `src/host/server-k8s.ts` | Unified host pod process for k8s deployment. Delegates shared init to `server-init.ts`. Keeps k8s-specific: NATS connection (work dispatch only), `/internal/*` routes (ipc, llm-proxy, workspace), web proxy with MITM CA, `stagingStore`, `activeTokens` registry. Uses `server-request-handlers.ts` for completions/models/scheduler. Use server-local.ts for local dev |
| `src/host/server-chat-api.ts` | Chat API handler — serves `/v1/chat/sessions` endpoints for chat UI thread list and history |
| `src/host/server-chat-ui.ts` | Chat UI static file serving — serves built chat UI from `dist/chat-ui/` at root path |
| `src/host/session-title.ts` | Auto-generate session titles from first user message using fast LLM model |
| `src/host/llm-proxy-core.ts` | Shared LLM credential injection and forwarding — used by both Unix socket proxy (`proxy.ts`) and HTTP route (`/internal/llm-proxy` in `server-k8s.ts`) |
| `src/host/oauth-skills.ts` | OAuth PKCE flow for skill credentials — manages pending flows (start → callback → token exchange → store), handles token refresh |
| `src/host/web-proxy-approvals.ts` | Web proxy approval coordination via event bus — replaces old in-memory promise map pattern. Works across stateless replicas (in-process for local, NATS for k8s) |
| `src/host/workspace-release-screener.ts` | Release-time screening for skill files and binaries — inspects workspace changes before GCS commit |
| `src/host/nats-session-protocol.ts` | NATS session protocol for k8s sandbox work dispatch coordination |
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
| `src/host/web-proxy.ts` | HTTP forward proxy for agent outbound HTTP/HTTPS. HTTP forwarding + HTTPS CONNECT tunneling, private IP blocking (SSRF), canary token scanning on request bodies, audit logging. Listens on Unix socket (container sandboxes) or TCP port (subprocess/k8s). Opt-in via `config.web_proxy` |
| `src/host/taint-budget.ts` | Per-session taint ratio tracking, action gating (SC-SEC-003) |
| `src/host/provider-map.ts` | Static allowlist mapping config names to provider modules (SC-SEC-002), plugin registration runtime allowlist |
| `src/host/registry.ts` | Loads and assembles ProviderRegistry from config; three loading patterns (simple, manual-import with deps, custom); plugin host integration |

## Request Lifecycle (server-local.ts + server-completions.ts)

### HTTP Completion Request

1. **HTTP Handler** -- Parse OpenAIChatRequest JSON, validate session_id, derive stable session ID (explicit -> user field -> random UUID), extract user/conversationId
2. **Router + Inbound Scan** -- Build InboundMessage, call `router.processInbound()` (scan, taint-wrap, canary inject, enqueue), emit `completion.start` and `scan.inbound` events
3. **Message Dequeue** -- Dequeue **by ID** (not FIFO) from MessageQueue
4. **Workspace Setup** -- Create workspace dir, load identity/skills from DocumentStore, build conversation history (DB-persisted for persistent sessions, client-provided for ephemeral), prepend parent channel context for thread sessions
5. **Credential Proxy** (claude-code only) -- Refresh OAuth pre-flight, start Anthropic credential-injecting proxy, pass proxy socket to agent
6. **Web Proxy** (opt-in, `config.web_proxy`) -- Start HTTP forward proxy per completion. Container sandboxes get a Unix socket (`web-proxy.sock` in IPC dir); subprocess gets a TCP port. Proxy enforces private IP blocking, canary scanning, and audit logging.
7. **Agent Spawn** -- Build spawn command with runner args, spawn with stdio pipes, write JSON payload to stdin (history, message, taintRatio, profile, requestId, identity, skills), collect stdout/stderr concurrently
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
- **sandbox** category: subprocess, docker, apple, k8s
- **workspace** category: none, local, gcs
- **skills** category: database only

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

## K8s HTTP Subsystem (K8s Deployment)

For Kubernetes deployments, k8s sandbox pods communicate with the host over HTTP (not NATS). NATS is used only for work dispatch (queue groups). The key HTTP routes on the host (`server-k8s.ts`):

- **`POST /internal/ipc`** — HTTP IPC route. Receives IPC requests from `HttpIPCClient` in k8s sandbox pods, routes through the same `handleIPC` pipeline as the Unix socket path. Authenticated via `Authorization: Bearer <ipcToken>`.
- **`POST /internal/llm-proxy/*`** — LLM proxy route. Forwards LLM requests to Anthropic API with credential injection via `llm-proxy-core.ts`. Allows claude-code pods to make LLM calls without API keys.
- **`nats-session-protocol.ts`** — NATS work dispatch coordination (queue groups for warm pod claiming).

**Removed files**: `nats-ipc-handler.ts` and `nats-llm-proxy.ts` have been replaced by HTTP routes in `server-k8s.ts` using shared `llm-proxy-core.ts`.

### Workspace Provision & Release (K8s)

In k8s mode, `server-k8s.ts` handles symmetric workspace file transfer between GCS and sandbox pods. The host is the single GCS credential holder — pods never access GCS directly.

**Provision** (GCS → host → pod):
1. **Provision endpoint** (`GET /internal/workspace/provision?scope=<agent|user|session>&id=<id>`): Reads scope files from GCS via `providers.workspace.downloadScope()`, returns gzipped JSON with base64-encoded file contents. Auth via `Authorization: Bearer <ipcToken>`.
2. **Pod-side**: `provisionScope()` in `src/agent/workspace.ts` fetches from this endpoint when `AX_HOST_URL` is set, decompresses, and writes files to the canonical mount paths.

**Release** (pod → host → GCS):
1. **Staging endpoint** (`POST /internal/workspace-staging`): Accepts gzipped JSON POST from sandbox pods (via workspace-cli.ts). Stores in in-memory `stagingStore` (Map with 5-min TTL, 50MB max). Returns `{ staging_key: UUID }`.
2. **workspace_release IPC interception**: When `wrappedHandleIPC` receives a `workspace_release` action (containing just a `staging_key`), it looks up staged data, decompresses with `gunzipSync`, decodes base64 content, and calls `providers.workspace.setRemoteChanges(sessionId, changes)`.
3. **Commit**: `workspace.commit(sessionId)` picks up stored changes via `RemoteTransport.diff()` and persists approved changes to GCS.

**GCS prefix resolution** (`server-completions.ts`): `resolveWorkspaceGcsPrefixes()` derives agent/user/session GCS prefixes from `config.workspace.prefix` (authoritative, same source as gcs.ts) with `AX_WORKSPACE_GCS_PREFIX` env var fallback. Both the write path (gcs.ts commit) and provision path must use the same prefix source.

The `AX_HOST_URL` env var (`http://ax-host.{namespace}.svc`) is passed to sandbox pods via `extraSandboxEnv` so they can reach both endpoints. NetworkPolicy allows sandbox pods egress to host on port 8080.

### Warm Pool (K8s)

Warm pool claiming is handled at the NATS queue group level — the host's `publishWork()` uses `nc.request('sandbox.work')` to deliver work to warm pods via queue groups before falling back to cold-starting a pod. The separate `warm-pool-client.ts` has been removed.

## Agent Registry

- **`agent-registry.ts`** — In-memory/file-based agent registry (`registry.json`) for single-server deployments.
- **`agent-registry-db.ts`** — Database-backed registry for PostgreSQL (k8s). Runs its own Kysely migration (`registry_001_agent_registry`). Stores agent metadata: id, name, description, status, parent_id, agent_type, capabilities.

## Admin API (`server-admin.ts`)

Admin endpoints for agent management and diagnostics. Protected by admin token (logged at startup for pod retrieval).

## Common Tasks

**Adding a new HTTP endpoint:**
1. Add URL match in `handleRequest()` in `server-local.ts`
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
- **SSE keepalive**: handleEvents sends `:keepalive\n\n` every 15s. Watch for keepalive timer leaks on early connection close.
- **Port flag support**: `--port <number>` listens on TCP instead of Unix socket.
- **Concurrent IPC calls**: Shared Unix socket can misroute responses if multiple IPC calls are in flight. Fixed by correlating request/response IDs.
- **proxy.sock race**: Must await IPC server listen before spawning agent, otherwise agent connects before socket is ready.
- **agent_response timeout**: Handle timeout gracefully without crashing the host process.
- **Container three-phase orchestration**: Docker/Apple sandboxes use provision (network on) → run (network off) → cleanup (network on). Do not assume network is available during the run phase.
- **K8s IPC is now HTTP-based**: `nats-ipc-handler.ts` and `nats-llm-proxy.ts` have been removed. K8s pods use `HttpIPCClient` → `POST /internal/ipc` HTTP route. NATS is only for work dispatch (queue groups).
- **Deleted files**: `nats-sandbox-dispatch.ts`, `agent-runtime-process.ts`, `local-sandbox-dispatch.ts`, `nats-ipc-handler.ts`, `nats-llm-proxy.ts`, `server.ts`, `host-process.ts` are all removed.
- **Error redaction in streams**: Streaming responses must redact internal errors before sending to client.
- **Web proxy per completion**: When `config.web_proxy` is enabled, a web proxy instance starts per completion (Unix socket for container sandboxes, TCP for subprocess). Cleanup happens in the completion finally block.
- **K8s web proxy**: In k8s mode, web proxy runs as a TCP server (port 3128, bound to `0.0.0.0`) in the host process. Sandbox pods connect via k8s Service (`ax-web-proxy.{namespace}.svc:3128`), passed as `AX_WEB_PROXY_URL`. Requires: (1) `config.web_proxy: true` in config, (2) `webProxy.enabled: true` in Helm values, (3) host network policy allowing ingress on port 3128 from execution plane. The `web_proxy` field must be in the Zod schema in `config.ts`.
- **K8s env var naming**: Never use env var names that K8s service discovery auto-generates. The `ax-web-proxy` Service generates `AX_WEB_PROXY_PORT=tcp://IP:PORT` in all pods. Our custom env var is `AX_PROXY_LISTEN_PORT` to avoid collision.
- **Warm pool payload propagation**: Per-request env vars must be in both the pod spec (`sandboxConfig.extraEnv` for cold spawn) AND the NATS work payload (`stdinPayload` fields like `webProxyUrl` for warm pool). The runner's `parseStdinPayload()` must extract and `applyPayload()` must set them in `process.env`.
- **K8s workspace staging store**: In-memory Map with 5-min TTL and 50MB max per entry. Periodic cleanup runs every 60s. Staging key is consumed (deleted) on workspace_release IPC lookup.
- **AX_HOST_URL env var**: Passed to sandbox pods for HTTP workspace provision and release. Points to `http://ax-host.{namespace}.svc`. NetworkPolicy must allow sandbox→host on port 8080.
- **GCS prefix must come from same source for read and write**: The GCS backend commits files using `config.workspace.prefix`. The provision path must use the same source via `resolveWorkspaceGcsPrefixes()`. If only the env var `AX_WORKSPACE_GCS_PREFIX` is set (not `config.workspace.prefix`), provisioning may silently point to the wrong path.
- **WorkspaceProvider.downloadScope()**: Optional method used by the provision endpoint. Only GCS provider implements it. The host calls `providers.workspace.downloadScope(scope, id)` and returns gzipped JSON to the pod.
