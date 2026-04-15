# Local/K8s Unification Design

**Date:** 2026-04-14
**Goal:** Minimize code divergence between local (Docker) and Kubernetes deployment modes to reduce maintenance burden.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sandbox providers | Docker only | Simplest to maintain; Apple Container removed |
| IPC transport | Unified interface, both implementations | Docker needs `--network=none` (socket only); k8s needs HTTP |
| Response channel | Always `agent_response` IPC action | Eliminates stdout parsing; works over both transports |
| Work dispatch | Stdin for first turn, IPC for subsequent | Keeps spawn fast; unifies multi-turn path |
| Server implementation | Single `server.ts` | One file, transport-agnostic; no conditional route registration |
| Session lifecycle | Always session-long | Docker containers stay alive like k8s pods; `SessionManager` manages both |
| Credentials | Always placeholders + MITM proxy | Agent never sees real values in either mode |
| Web proxy | Always enabled | Required for credential delivery; no opt-out |

## Architecture

### Unified Server (`server.ts`)

Single HTTP server that always registers all routes:

- **Public API:** `/v1/sessions`, `/v1/completions`, `/v1/events`, `/health`
- **Internal:** `/internal/ipc`, `/internal/work`, `/internal/llm-proxy`

Transport listeners (config-driven):
- Local: Unix socket (`~/.ax/ax.sock`) + optional TCP port
- K8s: TCP on `0.0.0.0:8080`

Internal routes are always present. In Docker mode, agents use the socket — HTTP internal routes go unused. No conditional route registration.

Per-turn token auth middleware only activates when `config.sandbox === 'k8s'`. For Docker/socket, the IPC handler is reached directly via the socket server.

### Unified Session Manager (`session-manager.ts`)

Replaces both fire-and-forget Docker model and `SessionPodManager`. Manages lifecycle of all sandbox sessions regardless of provider.

**State per session:**

```typescript
interface SessionEntry {
  sessionId: string
  sandboxProcess: SandboxProcess    // container or pod handle
  ipcChannel: IPCChannel            // socket or HTTP transport
  dirty: boolean                    // has the agent written files?
  lastActivity: number              // timestamp
  activeTurnId: string | null
  pendingResponse: Promise | null   // resolves on agent_response
}
```

**API:**
- `getOrCreate(sessionId, spawnOpts)` — returns existing session or spawns new sandbox
- `dispatchWork(sessionId, payload)` — sends work to existing session via IPC
- `onAgentResponse(sessionId, turnId, content)` — resolves pending response promise
- `touch(sessionId, dirty?)` — resets idle timer, optionally marks dirty
- `kill(sessionId)` — destroys sandbox, cleans up state
- `shutdown()` — kills all sessions (graceful server shutdown)

**Idle timeout** (same for Docker and k8s):
- Configurable `idle_timeout_sec` (default 300s)
- Dirty sessions get longer timeout (configurable)
- Warning event emitted before kill (120s before)
- On timeout: kill sandbox, remove session entry

### Unified Completion Flow

One function, not two:

```
processCompletion(sessionId, payload, deps):
  1. session = sessionManager.getOrCreate(sessionId)
  2. if new session → spawn sandbox, send payload via stdin
  3. if existing session → send dispatch_work via IPC
  4. register responsePromise keyed by turnId
  5. await responsePromise (resolved by agent_response IPC action)
  6. return response
```

### Unified Agent Lifecycle

```
Agent startup:
  1. Detect transport: AX_HOST_URL → HTTP, else → socket
  2. Create IPCClient (socket or HTTP implementation)
  3. Read stdin → parse first-turn payload
  4. Execute first turn
  5. Send agent_response via IPC
  6. Enter work loop:
     while (true):
       work = await ipcClient.call('fetch_work')
       if work === null → idle, continue
       if work === 'shutdown' → exit
       execute turn
       send agent_response via IPC
```

**IPCClient interface:**

```typescript
interface IPCClient {
  connect(): Promise<void>
  call(action: string, payload: object): Promise<object>
  close(): Promise<void>
}
```

Socket implementation: length-prefixed binary over Unix socket.
HTTP implementation: `POST /internal/ipc` with Bearer token.

### Credential & Web Proxy Path

**Always placeholders:**
- Host generates `ax-cred:<hex>` placeholders for every session
- Placeholders passed to agent via stdin payload's `extraSandboxEnv`
- Agent never sees real values
- `SharedCredentialRegistry` maps placeholders → real values for MITM proxy

**Web proxy always enabled:**
- Docker: Unix socket, agent reaches via `startWebProxyBridge()` (socket mount)
- K8s: TCP `0.0.0.0:3128`, agent reaches via k8s Service
- Both hit same `web-proxy.ts` core — MITM, placeholder replacement, domain allowlist, audit

## What Gets Deleted

**Files removed:**
- `src/host/server-local.ts` → unified `server.ts`
- `src/host/server-k8s.ts` → unified `server.ts`
- `src/host/session-pod-manager.ts` → `session-manager.ts`
- `src/providers/sandbox/apple.ts` → Docker only

**Code paths removed:**
- Stdout response parsing in `processCompletion()`
- Single-turn agent lifecycle
- Direct credential env var injection
- `web_proxy` config toggle
- Apple Container reverse bridge logic (`IPC_LISTEN` mode)

**Files simplified:**
- `src/agent/runner.ts` — transport branching to one line; single work-loop path
- `src/host/server-completions.ts` — one `processCompletion()`, no session variant
- `src/providers/sandbox/docker.ts` — always mount proxy socket
- `src/host/credential-placeholders.ts` — remove direct env var fallback

**Net estimate:** Delete ~800-1000 lines, add ~200-300. Net reduction ~500-700 lines.

## What Stays Divergent (Justified)

| Aspect | Docker | K8s | Why |
|--------|--------|-----|-----|
| IPC transport | Unix socket | HTTP | Docker `--network=none` blocks HTTP to host |
| Auth mechanism | Filesystem permissions | Per-turn Bearer token | Socket path = auth; HTTP needs explicit tokens |
| Sandbox spawning | `docker run` | kubectl API | Different platforms |
| Network model | `--network=none` + socket bridge | NetworkPolicy + HTTP | Platform constraint |

## Migration Steps

Each step is independently deployable:

1. Add `fetch_work` and `dispatch_work` IPC actions to schemas
2. Build `SessionManager` (generalize from `SessionPodManager`)
3. Build unified `server.ts` (merge server-local + server-k8s)
4. Update `processCompletion()` to use response promise (drop stdout)
5. Update `runner.ts` to always enter work loop after first turn
6. Make web proxy + placeholders mandatory
7. Delete old files (server-local, server-k8s, session-pod-manager, apple sandbox)
8. Update Helm chart entry point to `server.ts`

## Testing Focus

- Docker socket bridge + MITM proxy placeholder replacement (now mandatory)
- Session-long Docker containers with idle timeout (new behavior)
- `fetch_work` over Unix socket (new IPC action)
- K8s pods with unified `processCompletion()` (regression)
- Rollback: each step independently deployable; step 3 (server merge) is highest risk
