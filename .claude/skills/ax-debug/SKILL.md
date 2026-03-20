---
name: ax-debug
description: Use when debugging k8s-related issues, NATS IPC problems, HTTP IPC problems, workspace release failures, or any issue in the sandbox/host/agent communication pipeline — runs the full k8s code path in a local kind cluster with hot-reload via host volume mounts, or locally with debuggable processes
---

## Overview

Two debugging modes, depending on fidelity needed:

1. **Kind cluster** (`scripts/k8s-dev.sh`) — Real k8s pods with host volume mounts for ~5s iteration. Use this for production-parity debugging.
2. **Local processes** (`run-http-local.ts` / `run-nats-local.ts`) — Spawns child processes with NATS env. Use this when you don't need real k8s (simpler, faster startup).

## Kind Cluster Dev Loop (recommended)

Uses host volume mounts so `dist/`, `templates/`, and `skills/` are shared directly into kind pods. After `tsc`, changes are instantly visible — just restart node processes (not pods).

```
edit code → tsc (~2s) → flush (~3s) → test → read logs → fix → repeat
```

### Prerequisites

```bash
# One-time installs
brew install kind helm kubectl
brew install postgresql  # for db commands
# Docker must be running
# ANTHROPIC_API_KEY must be set
```

### Setup (one-time, ~3-5min)

```bash
npm run k8s:dev setup
```

This generates a kind config with volume mounts from `$(pwd)`, creates the cluster, builds, loads the Docker image, creates secrets, and installs the Helm chart with dev values.

### Iteration Commands

| Command | What it does | Time |
|---|---|---|
| `npm run k8s:dev build` | `tsc` only | ~2s |
| `npm run k8s:dev flush` | Delete sandbox pods (pool controller recreates from mount) | ~3-5s |
| `npm run k8s:dev flush all` | Above + restart host/pool-controller node processes | ~3-5s |
| `npm run k8s:dev cycle` | build + flush | ~5-7s |
| `npm run k8s:dev cycle all` | build + flush all | ~5-7s |
| `npm run k8s:dev test "<msg>"` | curl POST to chat completions endpoint | varies |
| `npm run k8s:dev logs [component]` | Tail logs — all, host, sandbox, or pool-controller | streaming |
| `npm run k8s:dev status` | Pod status + warm pool count | instant |
| `npm run k8s:dev teardown` | Delete kind cluster | ~10s |

### Autonomous Debug Loop

Claude Code can drive this loop without human intervention:

```
1. npm run k8s:dev logs sandbox        # Read error logs
2. Edit source file to fix the issue
3. npm run k8s:dev cycle               # build + flush (~5-7s)
4. npm run k8s:dev test "repro msg"    # Send test request
5. npm run k8s:dev logs sandbox        # Check if fix worked
6. If still broken, go to 2
```

For host-side issues, replace `cycle` with `cycle all` and `logs sandbox` with `logs host`.

### Debugging in Kind

#### Attach debugger to sandbox pod

```bash
npm run k8s:dev debug sandbox
```

Sets a debug flag on the sandbox template ConfigMap → next sandbox pod starts with `--inspect-brk=0.0.0.0:9230` → script watches for pod → port-forwards 9230 → prints "attach debugger now". Attach Chrome DevTools (`chrome://inspect`) or VS Code. Send a test request — that pod claims the work and pauses at startup.

#### Attach debugger to host pod

```bash
npm run k8s:dev debug host
```

Port-forwards localhost:9229 to the host pod (already running `--inspect=0.0.0.0:9229`).

#### Database access

```bash
npm run k8s:dev db                  # Interactive psql session
npm run k8s:dev db "SELECT ..."     # Run single SQL query
npm run k8s:dev db reset            # Drop and recreate database
```

### Volume Mount Chain

```
Host filesystem (dist/, templates/, skills/)
  ↓ kind extraMounts
Kind node (/ax-dev/dist, /ax-dev/templates, /ax-dev/skills)
  ↓ hostPath volumes
Pod containers (/opt/ax/dist, /opt/ax/templates, /opt/ax/skills)
```

The base Docker image still provides Node.js, `node_modules/`, and OS packages. You only rebuild Docker when `package.json` dependencies change.

### Kind Dev Files

- `scripts/k8s-dev.sh` — Main entry-point script with all subcommands
- `charts/ax/kind-dev-values.yaml` — Dev Helm values overlay with hostPath mounts and `--inspect` flags

## Local Process Debugging (alternative)

For issues that don't require real k8s (IPC protocol, LLM proxy, workspace release logic), use the local harnesses. Simpler setup, faster startup.

Two transport modes:
- **HTTP IPC** (`run-http-local.ts`): Production k8s path — IPC via HTTP POST to `/internal/ipc`
- **NATS IPC** (`run-nats-local.ts`): Legacy path — IPC via NATS request/reply

### Prerequisites

```bash
brew install nats-server
npm run build
```

### Quick Start — HTTP IPC (recommended)

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

The HTTP IPC harness replicates the full server-k8s.ts k8s route surface:
- `/internal/ipc` — IPC over HTTP with per-turn token auth
- `/internal/llm-proxy/*` — LLM credential injection proxy (claude-code sets `ANTHROPIC_BASE_URL` here)
- `/internal/workspace/release` — Direct workspace file upload from agent
- `/internal/workspace-staging` — Legacy two-phase workspace upload (staging_key + IPC release)
- NATS `sandbox.work` queue group for work delivery with retry
- `workspace_release` IPC intercept (for legacy staging path)
- `agent_response` IPC intercept to collect the agent reply

### Quick Start — NATS IPC

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

### Local Debugging Techniques

#### Add console.log to agent or host

Edit source files directly — the harness runs via `tsx` so changes are picked up on restart. Agent stdout/stderr is piped to the parent terminal.

Key files to instrument:

| What to debug | File | Key functions/lines |
|---|---|---|
| Work delivery (host->agent) | `src/host/server-k8s.ts` | `processCompletionWithNATS()`, `publishWork()` |
| HTTP IPC route (host) | `src/host/server-k8s.ts:718` | `/internal/ipc` POST handler, `activeTokens` |
| LLM proxy route (host) | `src/host/server-k8s.ts:692` | `/internal/llm-proxy/*`, token auth via `x-api-key` |
| LLM proxy core (host) | `src/host/llm-proxy-core.ts` | `forwardLLMRequest()` — credential injection + streaming |
| Workspace release (host) | `src/host/server-k8s.ts:636` | `/internal/workspace/release` direct upload |
| Workspace staging (host) | `src/host/server-k8s.ts:680` | `/internal/workspace-staging` legacy upload |
| Workspace release IPC (host) | `src/host/server-k8s.ts:415` | `workspace_release` IPC intercept with staging_key |
| Agent response (host) | `src/host/server-k8s.ts:444` | `agent_response` IPC intercept |
| NATS work reception (agent) | `src/agent/runner.ts` | `waitForNATSWork()` |
| HTTP IPC client (agent) | `src/agent/http-ipc-client.ts` | `call()`, `setContext()` |
| LLM base URL setup (agent) | `src/agent/runners/claude-code.ts:184` | Sets `ANTHROPIC_BASE_URL` to host proxy |
| Workspace release (agent) | `src/agent/workspace-release.ts` | `releaseWorkspaceScopes()` |
| Workspace CLI (agent) | `src/agent/workspace-cli.ts` | `provision`, `cleanup`, `release` commands |

#### Attach Node debugger to agent process

```bash
AX_DEBUG_AGENT=1 npx tsx tests/providers/sandbox/run-http-local.ts
```

Agent spawns with `--inspect-brk`. Attach Chrome DevTools (`chrome://inspect`) or VS Code debugger. The agent pauses at startup so you can set breakpoints before it processes work.

#### Attach Node debugger to host process

```bash
node --inspect -e "import('./tests/providers/sandbox/run-http-local.ts')"
```

#### Monitor NATS traffic

```bash
# Install NATS CLI (one-time)
brew install nats-io/nats-tools/nats

# Watch all NATS subjects
nats sub ">"

# Watch only work delivery
nats sub "sandbox.work"
```

### Local Environment Variables

| Env var | Default | Purpose |
|---|---|---|
| `AX_DEBUG_AGENT` | (unset) | Set to `1` to spawn agent with `--inspect-brk` |
| `NATS_URL` | `nats://localhost:4222` | NATS server URL |
| `AX_HOST_URL` | `http://localhost:8080` | Host URL for LLM proxy + workspace uploads |
| `PORT` | `8080` | Host HTTP port |
| `LOG_LEVEL` | `debug` | Log level for both host and agent |
| `ANTHROPIC_API_KEY` | (required) | Real API key — injected by LLM proxy into forwarded requests |

## Message Flow

### HTTP IPC mode (production k8s path)

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

### NATS IPC mode (legacy path)

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

### npm/pip install hangs in sandbox

**Root cause tree (check in order):**
1. `config.web_proxy` not set → host never starts proxy → `AX_WEB_PROXY_URL` never sent to sandboxes
2. Helm `webProxy.enabled: false` → no Service, no NetworkPolicy for port 3128
3. Service selector mismatch → service has no endpoints (check `kubectl get endpoints ax-web-proxy`)
4. Host NetworkPolicy blocks inbound port 3128 (only 8080 allowed by default)
5. Web proxy bound to 127.0.0.1 → unreachable from other pods (needs `bindHost: '0.0.0.0'`)
6. `AX_WEB_PROXY_URL` not in NATS payload → warm pool pods don't get it
7. `parseStdinPayload()` doesn't extract `webProxyUrl` → runner never sets `HTTP_PROXY`

**Debug steps:**
1. Check host logs for `web_proxy_started` — if missing, `config.web_proxy` is false
2. `kubectl get endpoints ax-web-proxy -n ax` — if empty, service selector is wrong
3. `kubectl exec <sandbox-pod> -- node -e "..."` to test TCP connectivity to host:3128
4. Check sandbox logs for `tool_execute name=bash` without subsequent `tool_result` — confirms hang
5. Check host logs for `proxy_request` with `CONNECT registry.npmjs.org:443` — confirms proxy is processing traffic

### Agent never responds (timeout)

**Debug steps:**
1. Check if agent process started: look for `[run-http-local] Work claimed by:` in host logs
2. Check if agent received work: look for NATS subscribe/reply in agent stderr
3. Check if runner crashes: look for stack traces in agent stderr
4. Use `AX_DEBUG_AGENT=1` (local) or `npm run k8s:dev debug sandbox` (kind) to attach debugger

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `NATS connection refused` | nats-server not running | `nats-server` (local) or check NATS pod (kind) |
| Agent spawns but no work delivered | NATS subject mismatch | Check `POD_NAME` env matches `sandbox.work` queue |
| LLM calls return 404 | Missing `/internal/llm-proxy` route | Use updated `run-http-local.ts` with LLM proxy route |
| LLM calls return 401 | Token not in `activeTokens` | Check `AX_IPC_TOKEN` passed to agent matches host registry |
| `No API credentials configured` | `ANTHROPIC_API_KEY` not set on host | Export `ANTHROPIC_API_KEY` in the terminal running the harness |
| `workspace_release_missing_staging` | Agent can't reach host HTTP | Check `AX_HOST_URL` is reachable from agent |
| Identity write returns `{ queued: true }` | Profile is paranoid or taint too high | Check profile setting; use `balanced` or `yolo` for testing |
| Agent hangs after spawning | Waiting for NATS work | Check host actually published to `sandbox.work` |
| `agent_response timeout` | Agent crashed or never responded | Check agent stderr for errors |
| IPC calls timing out | Token mismatch | Check `AX_IPC_TOKEN` and `AX_IPC_REQUEST_ID` match between host and agent |
| Kind pods not picking up changes | Volume mounts not working | Verify `npm run k8s:dev status`, check `kind get nodes` has mounts |
| Pod restart loop after flush | Code error in dist/ | Check `npm run k8s:dev logs sandbox` for stack trace, fix, `cycle` again |
| npm/pip install hangs in sandbox | No web proxy or HTTP_PROXY not set | Enable `webProxy.enabled` + `config.web_proxy: true` in Helm values. Check: (1) `ax-web-proxy` service has endpoints, (2) host-network policy allows port 3128 ingress, (3) sandbox-web-proxy-egress policy exists, (4) `AX_WEB_PROXY_URL` in NATS payload via `webProxyUrl` field |
| Host crashes with `ERR_SOCKET_BAD_PORT` NaN | K8s service `ax-web-proxy` auto-generates `AX_WEB_PROXY_PORT=tcp://IP:PORT` | Never use env var names that collide with k8s service discovery. Our env var is `AX_PROXY_LISTEN_PORT` (not `AX_WEB_PROXY_PORT`) |
| Web proxy unreachable from sandbox (ECONNREFUSED) | Proxy bound to 127.0.0.1 or service selector mismatch | Check `bindHost: '0.0.0.0'` in host-process.ts startWebProxy call. Verify service selector matches host pod labels (`ax.selectorLabels`) |
| Warm pool pod missing per-request env vars | Env var only in cold-spawn pod spec, not in NATS payload | Add to stdinPayload in server-completions.ts AND parseStdinPayload()+applyPayload() in runner.ts |

## Key Files

- `scripts/k8s-dev.sh` — Kind cluster dev loop entry point (setup, build, flush, cycle, test, logs, debug, db, teardown)
- `charts/ax/kind-dev-values.yaml` — Dev Helm values overlay with hostPath mounts and `--inspect` flags
- `tests/providers/sandbox/nats-subprocess.ts` — The sandbox provider (spawns local processes with NATS env, supports `ipcTransport: 'http'` option)
- `tests/providers/sandbox/run-http-local.ts` — Test harness for HTTP IPC mode (full host route surface: IPC, LLM proxy, workspace release/staging)
- `tests/providers/sandbox/run-nats-local.ts` — Test harness for NATS IPC mode (starts AX host with nats-subprocess)
- `src/host/server-k8s.ts` — Host-side k8s orchestration (`processCompletionWithNATS`, `activeTokens`, all `/internal/*` routes)
- `src/host/llm-proxy-core.ts` — LLM credential injection and streaming proxy (shared by socket proxy and HTTP route)
- `src/agent/runner.ts` — Agent entry point, transport selection (`AX_IPC_TRANSPORT`), NATS work reception
- `src/agent/http-ipc-client.ts` — Agent-side HTTP IPC client (POST to `/internal/ipc`)
- `src/agent/runners/claude-code.ts` — claude-code runner (sets `ANTHROPIC_BASE_URL` to host LLM proxy)
- `src/agent/workspace-release.ts` — Agent-side workspace file upload
- `src/host/ipc-handlers/identity.ts` — Identity read/write handler (queuing logic, taint gates)
- `tests/agent/http-ipc-client.test.ts` — Unit tests for HttpIPCClient
