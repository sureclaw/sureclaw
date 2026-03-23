---
name: ax-ipc
description: Use when modifying IPC protocol between host and agent — schemas, actions, length-prefix framing, or Zod validation in ipc-schemas.ts and ipc-server.ts
---

## Overview

AX host and agent processes communicate over Unix domain sockets using a length-prefixed JSON protocol. The host (`src/host/ipc-server.ts`) validates every inbound message against Zod strict schemas (`src/ipc-schemas.ts`) before dispatching to a handler. Long-running handlers send periodic heartbeat frames to keep the client alive.

In Kubernetes, HTTP-based IPC replaces Unix sockets: the agent uses `HttpIPCClient` (`src/agent/http-ipc-client.ts`) and the host receives requests via `POST /internal/ipc` route in `server-k8s.ts`, routing through the same `handleIPC` pipeline with identical schema validation.

## Protocol

- **Framing:** 4-byte big-endian `UInt32` length prefix, followed by a UTF-8 JSON payload of exactly that length.
- **Envelope format:** `{ "action": "<action_name>", ...fields }`. The `action` field is validated first, then the full payload validated against the action-specific strict schema.
- **Heartbeats:** During handler execution, the server sends `{ _heartbeat: true, ts: number }` frames every 15 seconds. Clients reset their timeout on each heartbeat.
- **Max message size:** 10 MB (server disconnects on oversize).
- **Default timeout:** 30 seconds (client-side, per call). Heartbeats reset the timer.

## Schema Validation (3-step)

1. **JSON parse** -- raw string to object.
2. **Envelope check** -- `IPCEnvelopeSchema` validates that `action` is in `VALID_ACTIONS`. Uses `.passthrough()` so extra fields survive to step 3.
3. **Action-specific schema** -- looked up from `IPC_SCHEMAS[action]`. Built with `z.strictObject()` via the `ipcAction()` helper. Rejects any field not explicitly declared.
4. **Taint budget check (step 3.5)** -- unless action is `identity_write`, `user_write`, or `identity_propose`.

Shared validators: `safeString(maxLen)`, `scopeName`, `uuid`, `pathSegment`.

## IIPCClient Interface

Minimal IPC client interface defined in `src/agent/runner.ts`, implemented by both `IPCClient` (Unix socket) and `HttpIPCClient` (HTTP for k8s):

```typescript
interface IIPCClient {
  call(request: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  connect(): Promise<void>;
  disconnect(): void;
  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string; token?: string }): void;
}
```

This interface enables transport-agnostic IPC usage in runners and tools (e.g. `compactHistory()`, `createLocalSandbox()`) without coupling to a specific transport.

## Actions Table

| Category    | Action                 | Key Request Fields                                        | Key Response Fields           |
|-------------|------------------------|-----------------------------------------------------------|-------------------------------|
| LLM         | `llm_call`             | `messages`, `model?`, `taskType?`, `tools?`, `temperature?`, `maxTokens?` | `chunks`                     |
| Image       | `image_generate`       | `prompt`, `model?`, `size?`, `quality?`                   | (provider result)             |
| Memory      | `memory_write`         | `scope`, `content`, `tags?`, `tainted?`                   | `id`                          |
| Memory      | `memory_query`         | `scope`, `query?`, `limit?`, `tags?`                      | `results`                     |
| Memory      | `memory_read`          | `id`                                                      | `entry`                       |
| Memory      | `memory_delete`        | `id`                                                      | `ok`                          |
| Memory      | `memory_list`          | `scope`, `limit?`                                         | `entries`                     |
| Web         | `web_fetch`            | `url`, `method?`, `headers?`, `timeoutMs?`                | (provider result)             |
| Web         | `web_search`           | `query`, `maxResults?`                                    | (provider result)             |
| Browser     | `browser_launch`       | `config?` (headless, viewport)                            | (session info)                |
| Browser     | `browser_navigate`     | `session`, `url`                                          | `ok`                          |
| Browser     | `browser_snapshot`     | `session`                                                 | (snapshot data)               |
| Browser     | `browser_click`        | `session`, `ref`                                          | `ok`                          |
| Browser     | `browser_type`         | `session`, `ref`, `text`                                  | `ok`                          |
| Browser     | `browser_screenshot`   | `session`                                                 | `data` (base64)               |
| Browser     | `browser_close`        | `session`                                                 | `ok`                          |
| Skills      | `skill_search`         | `query`, `limit?`                                         | (search results)              |
| Credentials | `credential_request`   | `envName`, `description?`                                 | `ok`, `available`             |
| Workspace   | `workspace_release`    | `staging_key`                                             | `ok`                          |
| Audit       | `audit_query`          | `filter?` (action, sessionId, since, until, limit)        | `entries`                     |
| Delegation  | `agent_delegate`       | `task`, `context?`, `runner?`, `model?`, `maxTokens?`, `timeoutSec?` | `response`             |
| Delegation  | `agent_collect`        | `delegationId`                                            | `response`                    |
| Orchestration | `agent_orch_status`  | `agentId?`                                                | `status`                      |
| Orchestration | `agent_orch_list`    | `sessionId?`                                              | `agents`                      |
| Orchestration | `agent_orch_tree`    | `agentId?`                                                | `tree`                        |
| Orchestration | `agent_orch_message` | `targetAgentId`, `content`                                | `ok`                          |
| Orchestration | `agent_orch_poll`    | (none)                                                    | `messages`                    |
| Orchestration | `agent_orch_interrupt` | `agentId`                                               | `ok`                          |
| Orchestration | `agent_orch_timeline`| `agentId?`, `since?`                                     | `events`                      |
| Identity    | `identity_read`        | `file`                                                    | `content`                     |
| Identity    | `identity_write`       | `file` (SOUL.md/IDENTITY.md), `content`, `reason`, `origin` | `applied` or `queued`      |
| Identity    | `identity_propose`     | `file`, `content`, `reason`, `origin`                     | `proposalId`                  |
| User        | `user_write`           | `userId`, `content`, `reason`, `origin`                   | `applied` or `queued`         |
| Governance  | `proposal_list`        | `status?` (pending/approved/rejected)                     | `proposals`                   |
| Governance  | `proposal_review`      | `proposalId`, `decision`, `reason?`                       | `ok`                          |
| Registry    | `agent_registry_list`  | `status?` (active/suspended/archived)                     | `agents`                      |
| Registry    | `agent_registry_get`   | `agentId`                                                 | `agent`                       |
| Scheduler   | `scheduler_add_cron`   | `schedule`, `prompt`, `maxTokenBudget?`, `delivery?`      | `jobId`                       |
| Scheduler   | `scheduler_run_at`     | `datetime`, `prompt`, `maxTokenBudget?`, `delivery?`      | `jobId`                       |
| Scheduler   | `scheduler_remove_cron`| `jobId`                                                   | `removed`                     |
| Scheduler   | `scheduler_list_jobs`  | (none)                                                    | `jobs`                        |
| Skills      | `skill_install`        | `skill`, `phase` (inspect/execute), `stepIndex?`, `inspectToken?` | (install result)       |
| Skills      | `skill_install_status` | `skill`                                                   | (install status)              |
| Sandbox     | `sandbox_bash`         | `command`                                                 | (exec result)                 |
| Sandbox     | `sandbox_read_file`    | `path`                                                    | `content`                     |
| Sandbox     | `sandbox_write_file`   | `path`, `content`                                         | `ok`                          |
| Sandbox     | `sandbox_edit_file`    | `path`, `old_string`, `new_string`                        | `ok`                          |
| Sandbox Audit | `sandbox_approve`    | `operation` (bash/read/write/edit), `command?`, `path?`, `content?`, `old_string?`, `new_string?` | `approved`, `reason?` |
| Sandbox Audit | `sandbox_result`     | `operation` (bash/read/write/edit), `command?`, `path?`, `success?`, `output?`, `error?`, `exitCode?` | `ok` |
| Plugin      | `plugin_list`          | (none)                                                    | `plugins`                     |
| Plugin      | `plugin_status`        | `packageName`                                             | (status result)               |

All responses are wrapped: `{ "ok": true, ...fields }` on success, `{ "ok": false, "error": "..." }` on failure.

### Sandbox Audit Gate Actions

`sandbox_approve` and `sandbox_result` support the **local sandbox execution model** used when the agent runs inside a container (Docker, Apple Container, k8s). Instead of routing sandbox tool calls through IPC to the host for execution, the agent executes them locally via `src/agent/local-sandbox.ts` with a host audit gate:

1. Agent calls `sandbox_approve` with the operation details -- host audits and returns `{approved: true/false}`.
2. If approved, agent executes the operation locally in its own container.
3. Agent calls `sandbox_result` to report the outcome (best-effort, fire-and-forget).

## Content Blocks

Messages support multiple block types:
- `text` -- plain text content (up to 200 KB)
- `tool_use` -- agent requesting a tool invocation
- `tool_result` -- result from a tool call
- `image` -- reference to stored image file via `fileId`
- `image_data` -- inline base64-encoded image data (transient, up to 20 MB encoded)

## Common Tasks

### Adding a new IPC action

1. **Schema** -- In `src/ipc-schemas.ts`, define via `ipcAction('action_name', { ...fields })`. Auto-registers in `IPC_SCHEMAS`.
2. **Handler** -- In `src/host/ipc-server.ts`, add entry to `handlers` record via domain module (e.g., `createLLMHandlers`). Receives `(req, ctx: IPCContext)`.
3. **Agent tools** -- Register in BOTH:
   - `src/agent/ipc-tools.ts` (TypeBox params, for pi-session runner)
   - `src/agent/mcp-server.ts` (Zod params, for claude-code runner)
4. **Tests** -- Update tool count assertion in `tests/sandbox-isolation.test.ts`.

### Handling long-running operations

- Server automatically sends heartbeat frames every 15 seconds
- Clients receive `{ _heartbeat: true, ts }` and reset their timeout
- Custom timeout per call: `client.call(request, timeoutMs)`
- Common long-running: `image_generate`, `agent_delegate`, `llm_call` (with thinking)

### Workspace operations

Workspace file syncing in k8s uses symmetric HTTP endpoints on the host (pods have no GCS credentials):

- **Provision** (start of turn): Pod GETs `GET /internal/workspace/provision?scope=<agent|user|session>&id=<id>` from the host. Host reads from GCS via `providers.workspace.downloadScope()`, returns gzipped JSON with base64-encoded file contents. `provisionScope()` in `src/agent/workspace.ts` handles this automatically when `AX_HOST_URL` is set.
- **Release** (end of turn): Agent-side `workspace-cli.ts release` POSTs gzipped file data to the host's `/internal/workspace-staging` HTTP endpoint. The agent then sends a lightweight `workspace_release` IPC action with just the `staging_key` UUID. The host looks up the staged data, decompresses, and feeds it to the workspace provider's `setRemoteChanges()`.

Both endpoints are authenticated via `Authorization: Bearer <ipcToken>`. The old `workspace_write`/`workspace_write_file` IPC actions have been removed — the workspace provider's mount/diff/commit pipeline is now the only write path.

### Sandbox tool operations

Sandbox tools (`sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_edit_file`) route through IPC to host-side handlers in `src/host/ipc-handlers/sandbox-tools.ts`. All file paths are validated with `safePath()` for workspace containment. In container mode, these instead route to `src/agent/local-sandbox.ts` using the `sandbox_approve`/`sandbox_result` audit gate.

## HTTP Transport (K8s)

In Kubernetes deployments, IPC uses HTTP instead of Unix sockets. NATS is only for work dispatch:

- **Agent-side**: `src/agent/http-ipc-client.ts` (`HttpIPCClient`) is a drop-in replacement for `IPCClient`. Selected automatically when `AX_HOST_URL` env var is set. POSTs JSON to `${hostUrl}/internal/ipc`.
- **Host-side**: `POST /internal/ipc` route in `src/host/server-k8s.ts` receives requests and routes through the existing `handleIPC` pipeline -- same schema validation, same handlers, same audit logging as Unix socket IPC.
- **Per-turn capability tokens**: Auth via `Authorization: Bearer <ipcToken>`. The host validates the token to prevent unauthorized IPC requests.
- **LLM proxy**: `POST /internal/llm-proxy/*` route in `server-k8s.ts` uses shared `llm-proxy-core.ts` for credential injection and Anthropic API forwarding.
- **Same schema validation**: HTTP payloads use the same Zod schemas as Unix socket IPC. The transport is transparent to the handler layer.

**Removed**: `nats-ipc-client.ts`, `nats-bridge.ts` (agent), `nats-ipc-handler.ts`, `nats-llm-proxy.ts` (host) have all been replaced by HTTP routes.

## Gotchas

- **Strict mode rejects unknown fields.** Unit tests with mock IPC won't catch this -- always test end-to-end.
- **Heartbeats expire after 15s of inactivity.** Handler timeout (15 min) is a safety net.
- **Two tool registries.** `ipc-tools.ts` (TypeBox) and `mcp-server.ts` (Zod) must stay in sync.
- **Taint budget.** `identity_write`, `user_write`, and `identity_propose` bypass the global taint check and handle taint internally.
- **Spread override.** The dispatcher does `{ ok: true, ...result }`. If a handler returns `{ ok: false }`, the spread overwrites `ok: true`.
- **Session ID scoping.** Clients can include `_sessionId` in requests (stripped before schema validation).
- **Heartbeats are metadata.** Clients should ignore `_heartbeat` frames and only process actual responses.
- **Concurrent IPC on shared socket.** Fixed misrouted responses when multiple `call()` requests are in-flight on the same Unix socket connection. Each request is now matched to its response correctly.
- **HTTP IPC for k8s.** `HttpIPCClient` uses HTTP POST to `/internal/ipc`. NATS is only for work dispatch (queue groups). The old `NATSIPCClient`, `nats-bridge.ts`, `nats-ipc-handler.ts`, and `nats-llm-proxy.ts` have all been removed.
