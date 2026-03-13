---
name: ipc
description: Use when modifying IPC protocol between host and agent — schemas, actions, length-prefix framing, or Zod validation in ipc-schemas.ts and ipc-server.ts
---

## Overview

AX host and agent processes communicate over Unix domain sockets using a length-prefixed JSON protocol. The host (`src/host/ipc-server.ts`) validates every inbound message against Zod strict schemas (`src/ipc-schemas.ts`) before dispatching to a handler. Long-running handlers send periodic heartbeat frames to keep the client alive.

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
| Skills      | `skill_read`           | `name`                                                    | `content`                     |
| Skills      | `skill_list`           | (none)                                                    | `skills`                      |
| Skills      | `skill_propose`        | `skill`, `content`, `reason?`                             | (proposal result)             |
| Skills      | `skill_import`         | `source`, `autoApprove?`                                  | (import result)               |
| Skills      | `skill_search`         | `query`, `limit?`                                         | (search results)              |
| Workspace   | `workspace_write`      | `tier` (agent/user), `path`, `content`                    | `ok`                          |
| Workspace   | `workspace_write_file` | `tier` (agent/user), `path`, `data` (base64), `mimeType`  | `ok`                          |
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
| Plugin      | `plugin_list`          | (none)                                                    | `plugins`                     |
| Plugin      | `plugin_status`        | `packageName`                                             | (status result)               |

All responses are wrapped: `{ "ok": true, ...fields }` on success, `{ "ok": false, "error": "..." }` on failure.

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

Two IPC workspace tiers for writes: `agent` (persistent), `user` (cross-agent). Reading/listing is done via local sandbox tools since tiers are mounted in the sandbox. Use `workspace_write_file` for binary (base64), `workspace_write` for text.

### Sandbox tool operations

Sandbox tools (`sandbox_bash`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_edit_file`) route through IPC to host-side handlers in `src/host/ipc-handlers/sandbox-tools.ts`. All file paths are validated with `safePath()` for workspace containment.

## NATS Transport (K8s)

In Kubernetes deployments, IPC is bridged over NATS instead of Unix sockets:

- **Agent-side**: `src/agent/nats-bridge.ts` provides a local HTTP server that claude-code hits via `ANTHROPIC_BASE_URL`. Publishes NATS requests to `ipc.llm.{sessionId}` for LLM calls and `ipc.request.{sessionId}` for tool calls.
- **Host-side**: `src/host/nats-llm-proxy.ts` subscribes to LLM subjects, proxies to Anthropic API. `src/host/nats-sandbox-dispatch.ts` handles sandbox tool dispatch with per-turn pod affinity.
- **Same schema validation**: NATS payloads use the same Zod schemas as Unix socket IPC.

## Gotchas

- **Strict mode rejects unknown fields.** Unit tests with mock IPC won't catch this -- always test end-to-end.
- **Heartbeats expire after 15s of inactivity.** Handler timeout (15 min) is a safety net.
- **Two tool registries.** `ipc-tools.ts` (TypeBox) and `mcp-server.ts` (Zod) must stay in sync.
- **Taint budget.** `identity_write`, `user_write`, and `identity_propose` bypass the global taint check and handle taint internally.
- **Spread override.** The dispatcher does `{ ok: true, ...result }`. If a handler returns `{ ok: false }`, the spread overwrites `ok: true`.
- **Session ID scoping.** Clients can include `_sessionId` in requests (stripped before schema validation).
- **Heartbeats are metadata.** Clients should ignore `_heartbeat` frames and only process actual responses.
