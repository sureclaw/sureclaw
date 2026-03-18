---
name: ax-debug
description: Use when debugging k8s-related issues, NATS IPC problems, HTTP IPC problems, workspace release failures, or any issue in the sandbox/host/agent communication pipeline — runs the full k8s code path locally with debuggable processes
---

## Overview

Debug the full k8s code path (NATS or HTTP IPC, workspace release via HTTP staging, work delivery) using local processes instead of real k8s pods. Uses the `nats-subprocess` sandbox provider to spawn debuggable child processes with NATS environment.

Two transport modes are available:
- **NATS IPC** (`run-nats-local.ts`): Agent uses `NATSIPCClient` — IPC calls go via NATS request/reply
- **HTTP IPC** (`run-http-local.ts`): Agent uses `HttpIPCClient` — IPC calls go via HTTP POST to `/internal/ipc`, NATS only for work delivery

**HTTP IPC is the production path for k8s.** Use `run-http-local.ts` for debugging real k8s issues.

## Prerequisites

```bash
# Install NATS server (one-time)
brew install nats-server

# Build AX
npm run build
```

## Quick Start — HTTP IPC (recommended for k8s debugging)

```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start AX with HTTP IPC transport
npx tsx tests/providers/sandbox/run-http-local.ts

# Terminal 3: Send a test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
```

The HTTP IPC harness replicates the full host-process.ts k8s route surface:
- `/internal/ipc` — IPC over HTTP with per-turn token auth
- `/internal/llm-proxy/*` — LLM credential injection proxy (claude-code sets `ANTHROPIC_BASE_URL` here)
- `/internal/workspace/release` — Direct workspace file upload from agent
- `/internal/workspace-staging` — Legacy two-phase workspace upload (staging_key + IPC release)
- NATS `sandbox.work` queue group for work delivery with retry
- `workspace_release` IPC intercept (for legacy staging path)
- `agent_response` IPC intercept to collect the agent reply

## Quick Start — NATS IPC

```bash
# Terminal 1: Start NATS
nats-server

# Terminal 2: Start AX with nats-subprocess sandbox (NATS IPC)
npx tsx tests/providers/sandbox/run-nats-local.ts

# Terminal 3: Send a test request
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"default","messages":[{"role":"user","content":"hello"}]}'
```

## Debugging Techniques

### Add console.log to agent or host

Edit source files directly -- the harness runs via `tsx` so changes are picked up on restart. Agent stdout/stderr is piped to the parent terminal.

Key files to instrument:

| What to debug | File | Key functions/lines |
|---|---|---|
| Work delivery (host->agent) | `src/host/host-process.ts` | `processCompletionWithNATS()`, `publishWork()` |
| HTTP IPC route (host) | `src/host/host-process.ts:718` | `/internal/ipc` POST handler, `activeTokens` |
| LLM proxy route (host) | `src/host/host-process.ts:692` | `/internal/llm-proxy/*`, token auth via `x-api-key` |
| LLM proxy core (host) | `src/host/llm-proxy-core.ts` | `forwardLLMRequest()` — credential injection + streaming |
| Workspace release (host) | `src/host/host-process.ts:636` | `/internal/workspace/release` direct upload |
| Workspace staging (host) | `src/host/host-process.ts:680` | `/internal/workspace-staging` legacy upload |
| Workspace release IPC (host) | `src/host/host-process.ts:415` | `workspace_release` IPC intercept with staging_key |
| Agent response (host) | `src/host/host-process.ts:444` | `agent_response` IPC intercept |
| NATS work reception (agent) | `src/agent/runner.ts` | `waitForNATSWork()` |
| HTTP IPC client (agent) | `src/agent/http-ipc-client.ts` | `call()`, `setContext()` |
| LLM base URL setup (agent) | `src/agent/runners/claude-code.ts:184` | Sets `ANTHROPIC_BASE_URL` to host proxy |
| Workspace release (agent) | `src/agent/workspace-release.ts` | `releaseWorkspaceScopes()` |
| Workspace CLI (agent) | `src/agent/workspace-cli.ts` | `provision`, `cleanup`, `release` commands |

### Attach Node debugger to agent process

```bash
AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-http-local.ts
```

Agent spawns with `--inspect-brk`. Attach Chrome DevTools (`chrome://inspect`) or VS Code debugger. The agent pauses at startup so you can set breakpoints before it processes work.

### Attach Node debugger to host process

```bash
node --inspect -e "import('./tests/providers/sandbox/run-http-local.ts')"
```

### Monitor NATS traffic

```bash
# Install NATS CLI (one-time)
brew install nats-io/nats-tools/nats

# Watch all NATS subjects
nats sub ">"

# Watch only work delivery
nats sub "sandbox.work"
```

### Environment variables

| Env var | Default | Purpose |
|---|---|---|
| `AX_DEBUG_AGENT` | (unset) | Set to `1` to spawn agent with `--inspect-brk` |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `AX_HOST_URL` | `http://localhost:8080` | Host URL for LLM proxy + workspace uploads |
| `PORT` | `8080` | Host HTTP port |
| `LOG_LEVEL` | `debug` | Log level for both host and agent |
| `ANTHROPIC_API_KEY` | (required) | Real API key — injected by LLM proxy into forwarded requests |

## Message Flow

### HTTP IPC mode (run-http-local.ts) — production k8s path

```
1. Host spawns local process with AX_IPC_TRANSPORT=http
2. Agent creates HttpIPCClient, connects to NATS
3. Agent subscribes to sandbox.work queue group
4. Host publishes work payload via NATS request (retries until subscriber ready)
5. Agent receives work, provisions workspace
6. Agent starts runner (claude-code or pi-session)
7. (claude-code) LLM calls go to ${AX_HOST_URL}/internal/llm-proxy/v1/messages
   - Per-turn token sent as x-api-key header
   - Host validates token, injects real ANTHROPIC_API_KEY, streams response
8. Agent makes IPC calls via HTTP POST to /internal/ipc (bearer token auth)
   - identity_read, identity_write, tool calls, etc.
9. Agent diffs workspace, POSTs to /internal/workspace/release (bearer token)
10. Agent sends agent_response via HTTP IPC
11. Host resolves agentResponsePromise, returns to caller
```

### NATS IPC mode (run-nats-local.ts) — legacy path

```
1. Host spawns local process with AX_IPC_TRANSPORT=nats
2. Agent connects to NATS, subscribes to sandbox.work queue group
3. Host publishes work payload via NATS
4. Agent processes work, makes IPC calls via ipc.request.{requestId}.{token}
5. Host's NATS IPC handler responds to each IPC call
6. (claude-code only) LLM calls proxied via ipc.llm.{requestId}.{token}
7. Agent diffs workspace, POSTs to host /internal/workspace-staging
8. Agent sends workspace_release IPC with staging_key
9. Agent sends agent_response IPC with result content
10. Host resolves completion, returns to caller
```

## Debugging Specific Issues

### LLM responses hanging

**Root cause:** Agent's `ANTHROPIC_BASE_URL` is set to `${AX_HOST_URL}/internal/llm-proxy` but the host doesn't have that route, or the token is not in `activeTokens`.

**Debug steps:**
1. Check agent stderr for HTTP errors from the LLM proxy
2. Add `console.log` in `src/host/llm-proxy-core.ts:forwardLLMRequest()` to see if requests arrive
3. Verify `ANTHROPIC_API_KEY` is set in the host process environment
4. Check `llm-proxy-core.ts:138-142` — `transfer-encoding` is stripped from upstream response headers; verify the agent SDK handles unbuffered streaming correctly

### Identity not being saved

**Root cause:** Identity writes go through IPC `identity_write` handler. In k8s, the handler may queue writes instead of applying them.

**Debug steps:**
1. Add `console.log` in `src/host/ipc-handlers/identity.ts:identity_write` handler
2. Check if `hasAnyAdmin()` returns true — if so, non-admin users are blocked
3. Check profile setting — `paranoid` always queues writes, `balanced` applies when taint is clean
4. Check taint budget — high taint ratio blocks writes
5. Look for `{ queued: true }` responses in IPC logs — agent gets "queued" but interprets it as success
6. Verify DocumentStore backend — SQLite is per-pod in k8s (ephemeral), PostgreSQL persists across pods

### Workspace release failures

**Debug steps:**
1. Check agent stderr for HTTP errors from `/internal/workspace/release`
2. The agent uses `workspace-cli.ts` as a subprocess — check its exit code
3. In legacy mode, check staging_key lifecycle: upload → staging_key → IPC workspace_release
4. Staging entries expire after 5 minutes — if the agent takes too long, the key is gone

### Agent never responds (timeout)

**Debug steps:**
1. Check if agent process started: look for `[run-http-local] Work claimed by:` in host logs
2. Check if agent received work: look for NATS subscribe/reply in agent stderr
3. Check if runner crashes: look for stack traces in agent stderr
4. Use `AX_DEBUG_AGENT=1` to attach debugger and see where agent hangs

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `NATS connection refused` | nats-server not running | `nats-server` in separate terminal |
| Agent spawns but no work delivered | NATS subject mismatch | Check `POD_NAME` env matches `sandbox.work` queue |
| LLM calls return 404 | Missing `/internal/llm-proxy` route | Use updated `run-http-local.ts` with LLM proxy route |
| LLM calls return 401 | Token not in `activeTokens` | Check `AX_IPC_TOKEN` passed to agent matches host registry |
| `No API credentials configured` | `ANTHROPIC_API_KEY` not set on host | Export `ANTHROPIC_API_KEY` in the terminal running the harness |
| `workspace_release_missing_staging` | Agent can't reach host HTTP | Check `AX_HOST_URL` is reachable from agent |
| Identity write returns `{ queued: true }` | Profile is paranoid or taint too high | Check profile setting; use `balanced` or `yolo` for testing |
| Agent hangs after spawning | Waiting for NATS work | Check host actually published to `sandbox.work` |
| `agent_response timeout` | Agent crashed or never responded | Check agent stderr for errors |
| IPC calls timing out | Token mismatch | Check `AX_IPC_TOKEN` and `AX_IPC_REQUEST_ID` match between host and agent |

## Key Files

- `tests/providers/sandbox/nats-subprocess.ts` -- The sandbox provider (spawns local processes with NATS env, supports `ipcTransport: 'http'` option)
- `tests/providers/sandbox/run-http-local.ts` -- Test harness for HTTP IPC mode (full host route surface: IPC, LLM proxy, workspace release/staging)
- `tests/providers/sandbox/run-nats-local.ts` -- Test harness for NATS IPC mode (starts AX host with nats-subprocess)
- `src/host/host-process.ts` -- Host-side k8s orchestration (`processCompletionWithNATS`, `activeTokens`, all `/internal/*` routes)
- `src/host/llm-proxy-core.ts` -- LLM credential injection and streaming proxy (shared by socket proxy and HTTP route)
- `src/agent/runner.ts` -- Agent entry point, transport selection (`AX_IPC_TRANSPORT`), NATS work reception
- `src/agent/http-ipc-client.ts` -- Agent-side HTTP IPC client (POST to `/internal/ipc`)
- `src/agent/runners/claude-code.ts` -- claude-code runner (sets `ANTHROPIC_BASE_URL` to host LLM proxy)
- `src/agent/workspace-release.ts` -- Agent-side workspace file upload
- `src/host/ipc-handlers/identity.ts` -- Identity read/write handler (queuing logic, taint gates)
- `tests/agent/http-ipc-client.test.ts` -- Unit tests for HttpIPCClient

## Fast Kind Cluster Dev Loop

For iterating on code running in a real kind cluster (vs the local harnesses above):

### One-time setup
```bash
npm run k8s:dev setup   # ~3-5 min — creates cluster, builds, deploys
```

### The fast loop
```bash
# Edit code, then:
npm run k8s:dev cycle         # tsc + flush sandbox pods (~5-7s)
npm run k8s:dev test "hello"  # send test request
npm run k8s:dev logs sandbox  # check output

# For host code changes:
npm run k8s:dev cycle all     # also restarts host + pool-controller
```

### All commands
| Command | What |
|---|---|
| `setup` | Create kind cluster + deploy AX |
| `build` | tsc only |
| `flush [all]` | Flush sandbox pods (or all) |
| `cycle [all]` | build + flush |
| `test "msg"` | Send chat completion request |
| `logs [component]` | Tail logs (host/sandbox/pool-controller/all) |
| `status` | Pod + warm pool status |
| `debug host` | Port-forward host debugger (9229) |
| `debug sandbox` | Enable --inspect-brk on next sandbox pod |
| `db` | Interactive psql |
| `db "query"` | Run SQL query |
| `db reset` | Drop + recreate database |
| `teardown` | Delete kind cluster |
