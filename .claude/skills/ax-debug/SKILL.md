---
name: ax-debug
description: Use when debugging k8s-related issues, NATS IPC problems, HTTP IPC problems, workspace release failures, or any issue in the sandbox/host/agent communication pipeline — starts with e2e test infrastructure for fast repro, falls back to full kind cluster or local process harnesses only when needed
---

## Overview

Three debugging tiers, in order of preference:

1. **E2E test infrastructure** (`tests/e2e/`) — Automated vitest suite with mock providers, scripted LLM responses, and a kind cluster managed by `global-setup.ts`. **Start here.** Fastest iteration, deterministic, CI-friendly.
2. **Kind cluster dev loop** (`scripts/k8s-dev.sh`) — Real k8s pods with host volume mounts for ~5s iteration. Use this when you need production-parity pod behavior (network policies, PVCs, NATS bridge, multi-pod communication) that the e2e suite can't replicate.
3. **Local process harnesses** (`run-http-local.ts` / `run-nats-local.ts`) — Spawns child processes with NATS env. Use this when you need to attach a debugger to individual processes or test IPC edge cases without k8s overhead.

**Always try Tier 1 first.** Most bugs can be reproduced and fixed with a new scripted turn + test case in under a minute. Only escalate when the bug genuinely requires real k8s infrastructure or manual debugging.

---

## Tier 1: E2E Test Infrastructure (preferred)

The `tests/e2e/` suite runs against a live AX server deployed in kind, but with all external services mocked. LLM responses are deterministic (scripted turns), so tests are reproducible.

### Architecture

```
global-setup.ts
  ├── Starts mock-server (OpenRouter, ClawHub, GCS, Linear)
  ├── Creates kind cluster (or uses AX_SERVER_URL if set)
  ├── Builds + loads Docker image
  ├── Deploys AX via Helm (kind-values.yaml)
  ├── Port-forwards AX service
  └── Sets AX_SERVER_URL + MOCK_SERVER_PORT env vars

regression.test.ts
  ├── AcceptanceClient (SSE-aware HTTP client)
  └── Sequential test cases: health → bootstrap → persistence → tools → files → ...

mock-server/
  ├── index.ts        — Router dispatching to handlers
  ├── openrouter.ts   — Scripted LLM responses (ScriptedTurn queue)
  ├── clawhub.ts      — Mock skill registry
  ├── gcs.ts          — In-memory GCS storage
  └── linear.ts       — Mock Linear API

scripts/
  ├── types.ts        — ScriptedTurn { match, response, finishReason }
  ├── index.ts        — ALL_TURNS aggregate
  ├── bootstrap.ts    — Bootstrap scenario turns
  ├── chat.ts         — Basic chat turns
  ├── memory.ts       — Memory lifecycle turns
  ├── scheduler.ts    — Scheduler turns
  └── skills.ts       — Skill install turns
```

### Debugging workflow

```
1. Reproduce: Write a failing test case in regression.test.ts
2. Add scripted turn(s) in scripts/ if the test needs new LLM responses
3. Run: npm run test:e2e
4. Read logs: check kind pod logs or AX_SERVER_URL server logs
5. Fix the code
6. Re-run: npm run test:e2e
7. Green? Done. Commit the test as a regression guard.
```

### Commands

```bash
# Full suite (creates kind cluster, runs tests, tears down)
npm run test:e2e

# Against an existing server (skips cluster creation/teardown)
AX_SERVER_URL=http://localhost:8080 npm run test:e2e

# Run a single test by name
npx vitest run --config tests/e2e/vitest.config.ts -t "server health check"
```

### Adding a reproduction test

1. **Add a scripted turn** in the relevant `tests/e2e/scripts/<category>.ts`:

```typescript
export const MY_BUG_TURNS: ScriptedTurn[] = [
  {
    match: /trigger the bug/i,
    response: {
      content: 'I will now call the problematic tool.',
      tool_calls: [{
        id: 'call_bug1',
        type: 'function',
        function: { name: 'bash', arguments: JSON.stringify({ command: 'echo repro' }) },
      }],
    },
  },
];
```

2. **Register it** in `tests/e2e/scripts/index.ts` (add to `ALL_TURNS`).

3. **Add the test case** in `regression.test.ts`:

```typescript
test('XX. repro: description of the bug', async () => {
  const sessionId = `${SESSION_PREFIX}:repro`;
  const res = await client.sendMessage(
    'trigger the bug',
    { sessionId, user: 'testuser', timeoutMs: 90_000 },
  );
  expect(res.status).toBe(200);
  // Assert the correct behavior after the fix
}, 120_000);
```

4. **Run it**: `npm run test:e2e`

### Adding a mock endpoint

If your bug involves an external service not yet mocked, add a handler in `tests/e2e/mock-server/`:

1. Create `tests/e2e/mock-server/<service>.ts` with a `handle<Service>(req, res)` function
2. Wire it into `tests/e2e/mock-server/index.ts` route dispatch
3. Add `url_rewrites` to `tests/e2e/kind-values.yaml` so the agent's requests route to the mock

### Key files

| File | Purpose |
|------|---------|
| `tests/e2e/regression.test.ts` | Sequential regression test suite |
| `tests/e2e/client.ts` | `AcceptanceClient` — SSE-aware HTTP client |
| `tests/e2e/global-setup.ts` | Kind cluster lifecycle, mock server, port-forward |
| `tests/e2e/vitest.config.ts` | Separate vitest config (`npm run test:e2e`) |
| `tests/e2e/kind-values.yaml` | Helm overrides (subprocess sandbox, mock URLs, url_rewrites) |
| `tests/e2e/mock-server/` | Mock external services |
| `tests/e2e/scripts/` | ScriptedTurn definitions for deterministic LLM responses |

### When to escalate to Tier 2 or 3

- Bug only reproduces with real NATS bridge (not subprocess sandbox)
- Bug requires network policies, PVCs, or multi-pod communication
- Bug is in pod lifecycle (warm pool, pool controller, pod restart)
- Bug requires attaching a Node.js debugger to a running process
- Bug is in Docker container isolation specifics

---

## Tier 2: Kind Cluster Dev Loop

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

---

## Tier 3: Local Process Debugging

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

### Local Harness Files

- `tests/providers/sandbox/nats-subprocess.ts` — The sandbox provider (spawns local processes with NATS env, supports `ipcTransport: 'http'` option)
- `tests/providers/sandbox/run-http-local.ts` — Test harness for HTTP IPC mode (full host route surface)
- `tests/providers/sandbox/run-nats-local.ts` — Test harness for NATS IPC mode

---

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

---

## Debugging Specific Issues

### LLM responses hanging

**Root cause:** Agent's `ANTHROPIC_BASE_URL` is set to `${AX_HOST_URL}/internal/llm-proxy` but the host doesn't have that route, or the token is not in `activeTokens`.

**Debug steps:**
1. **Tier 1**: Add a scripted turn that triggers the LLM call path, check if mock OpenRouter receives the request
2. **Tier 3**: Check agent stderr for HTTP errors from the LLM proxy
3. Add `console.log` in `src/host/llm-proxy-core.ts:forwardLLMRequest()` to see if requests arrive
4. Verify `ANTHROPIC_API_KEY` is set in the host process environment

### Identity not being saved

**Root cause:** Identity writes go through IPC `identity_write` handler. In k8s, the handler may queue writes instead of applying them.

**Debug steps:**
1. **Tier 1**: Add a bootstrap test that writes identity and verifies persistence in a new session
2. Add `console.log` in `src/host/ipc-handlers/identity.ts:identity_write` handler
3. Check if `hasAnyAdmin()` returns true — if so, non-admin users are blocked
4. Check profile setting — `paranoid` always queues writes, `balanced` applies when taint is clean
5. Check taint budget — high taint ratio blocks writes

### Workspace release failures

**Debug steps:**
1. **Tier 1**: Add a file-create test case, check if GCS mock receives the upload
2. **Tier 3**: Check agent stderr for HTTP errors from `/internal/workspace/release`
3. The agent uses `workspace-cli.ts` as a subprocess — check its exit code
4. In legacy mode, check staging_key lifecycle: upload → staging_key → IPC workspace_release

### npm/pip install hangs in sandbox

**Root cause tree (check in order):**
1. `config.web_proxy` not set → host never starts proxy → `AX_WEB_PROXY_URL` never sent to sandboxes
2. Helm `webProxy.enabled: false` → no Service, no NetworkPolicy for port 3128
3. Service selector mismatch → service has no endpoints
4. Host NetworkPolicy blocks inbound port 3128
5. Web proxy bound to 127.0.0.1 → unreachable from other pods

**Debug steps:**
1. **Tier 1**: The e2e suite uses `web_proxy: true` in kind-values.yaml — check if proxy tests pass
2. **Tier 2**: Check host logs for `web_proxy_started`, check `kubectl get endpoints ax-web-proxy -n ax`
3. `kubectl exec <sandbox-pod> -- node -e "..."` to test TCP connectivity to host:3128

### Agent never responds (timeout)

**Debug steps:**
1. **Tier 1**: Check if the health check test passes, then check if scripted turns are being consumed
2. **Tier 3**: Check if agent process started: look for `[run-http-local] Work claimed by:` in host logs
3. Check if runner crashes: look for stack traces in agent stderr
4. Use `AX_DEBUG_AGENT=1` (Tier 3) or `npm run k8s:dev debug sandbox` (Tier 2) to attach debugger

---

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
| npm/pip install hangs in sandbox | No web proxy or HTTP_PROXY not set | Enable `webProxy.enabled` + `config.web_proxy: true` in Helm values |
| Host crashes with `ERR_SOCKET_BAD_PORT` NaN | K8s service auto-generates conflicting env var | Our env var is `AX_PROXY_LISTEN_PORT` (not `AX_WEB_PROXY_PORT`) |
| Web proxy unreachable from sandbox | Proxy bound to 127.0.0.1 or service selector mismatch | Check `bindHost: '0.0.0.0'`, verify service selector matches host pod labels |
| Warm pool pod missing per-request env vars | Env var only in cold-spawn pod spec, not in NATS payload | Add to stdinPayload in server-completions.ts AND parseStdinPayload()+applyPayload() in runner.ts |
| E2E test fails with "no scripted turn" | Mock OpenRouter ran out of turns | Add missing `ScriptedTurn` entries in `tests/e2e/scripts/` |
