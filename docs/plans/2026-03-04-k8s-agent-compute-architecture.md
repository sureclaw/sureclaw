# AX on Kubernetes — Agent Compute Architecture

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deploy AX on GKE Autopilot with multiple stateless replicas, shared PostgreSQL, and secure multi-tenant agent execution.

**Architecture:** Three-layer system — stateless HTTP ingress (host pods), conversation processing (agent runtime pods running pi-session subprocesses), and isolated code execution (sandbox pods for bash/file tools and claude-code agents). NATS JetStream is the single communication layer between all components. PostgreSQL replaces SQLite for shared state.

**Tech Stack:** TypeScript, Node.js, GKE Autopilot, NATS JetStream, Cloud SQL (PostgreSQL), gVisor, nats.js, @kubernetes/client-node

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [Platform Constraints](#platform-constraints)
3. [Architecture Overview](#architecture-overview)
4. [Component Details](#component-details)
5. [New Provider Abstractions](#new-provider-abstractions)
6. [NATS Topology](#nats-topology)
7. [Execution Flows](#execution-flows)
8. [Security Model](#security-model)
9. [Workspace & Storage Strategy](#workspace--storage-strategy)
10. [Observability](#observability)
11. [Phased Implementation](#phased-implementation)
12. [Migration from Current Architecture](#migration-from-current-architecture)
13. [Helm Chart + FluxCD GitOps](#helm-chart--fluxcd-gitops)

---

## Design Principles

1. **The pod boundary is the security boundary.** No in-pod multi-tenant isolation on Autopilot (no `CAP_SYS_ADMIN`, no `CLONE_NEWUSER`, no custom seccomp). Every untrusted code execution gets its own pod.

2. **Separate ingress, conversation, and execution.** HTTP handling (host pods), agent conversation loops (agent runtime pods), and code execution (sandbox pods) are distinct scaling units with different resource profiles.

3. **NATS is the single communication layer.** Task dispatch, event streaming, IPC callbacks, and LLM proxying all flow through NATS JetStream. One piece of infrastructure, one protocol to maintain.

4. **Provider contracts preserve local dev.** Every new infrastructure dependency (NATS, PostgreSQL, k8s API) is abstracted behind a provider interface with a local implementation (in-process EventBus, SQLite, subprocess sandbox). `ax start` on a laptop works exactly as today.

5. **Right-size incrementally.** Start with the simplest deployment that enforces the security model. Extract components only when concrete workloads demand them.

---

## Platform Constraints: GKE Autopilot

| Constraint | Implication |
|---|---|
| No `privileged: true`, no `CAP_SYS_ADMIN` | nsjail, bubblewrap, and user namespace sandboxing are impossible inside pods |
| `requests == limits` (Guaranteed QoS only) | Pods must be sized precisely; no bursting, no overcommit |
| No node SSH or custom node config | Cannot pre-pull images via DaemonSets or tune kernel params |
| gVisor available via `runtimeClassName: gvisor` | Per-pod kernel-level isolation for untrusted workloads |
| Autopilot auto-provisions nodes | First pod of a new resource profile may trigger 60-120s node provisioning |
| Compute classes available | `general-purpose` (default), `Performance` (up to 222 vCPU / 851 GiB) |
| KEDA available | Can scale based on NATS queue depth or custom metrics |

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                        INGRESS LAYER                              │
│            Deployment: ax-host (replicas: 2-3)                    │
│                                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                       │
│  │ Host     │  │ Host     │  │ Host     │   Stateless, behind   │
│  │ Pod A    │  │ Pod B    │  │ Pod C    │   k8s Service / LB    │
│  │          │  │          │  │          │                        │
│  │ HTTP API │  │ HTTP API │  │ HTTP API │   Routes:              │
│  │ SSE      │  │ SSE      │  │ SSE      │    /v1/chat/completions│
│  │ Webhooks │  │ Webhooks │  │ Webhooks │    /v1/events (SSE)    │
│  │ Admin    │  │ Admin    │  │ Admin    │    /webhooks/*          │
│  │ Channels │  │ Channels │  │ Channels │    /admin/*             │
│  │          │  │          │  │          │                        │
│  │ 0.5 CPU  │  │ 0.5 CPU  │  │ 0.5 CPU  │                       │
│  │ 512Mi    │  │ 512Mi    │  │ 512Mi    │                       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                       │
│       └──────────────┼──────────────┘                            │
└──────────────────────┼───────────────────────────────────────────┘
                       │
                 ┌─────┴─────┐
                 │   NATS    │  StatefulSet: nats (3 replicas)
                 │ JetStream │  JetStream enabled
                 │           │  0.5 CPU / 1Gi per pod
                 └─────┬─────┘
                       │
┌──────────────────────┼───────────────────────────────────────────┐
│              CONVERSATION PLANE                                    │
│            Deployment: ax-agent-runtime (replicas: 3-5)           │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ Agent        │  │ Agent        │  │ Agent        │           │
│  │ Runtime A    │  │ Runtime B    │  │ Runtime C    │           │
│  │              │  │              │  │              │           │
│  │ Parent proc: │  │ Parent proc: │  │ Parent proc: │           │
│  │  NATS client │  │  NATS client │  │  NATS client │           │
│  │  IPC server  │  │  IPC server  │  │  IPC server  │           │
│  │  LLM proxy   │  │  LLM proxy   │  │  LLM proxy   │           │
│  │  DB client   │  │  DB client   │  │  DB client   │           │
│  │              │  │              │  │              │           │
│  │ Subprocesses:│  │ Subprocesses:│  │ Subprocesses:│           │
│  │  pi-session  │  │  pi-session  │  │  pi-session  │           │
│  │  pi-session  │  │  pi-session  │  │  pi-session  │           │
│  │  ...         │  │  ...         │  │  ...         │           │
│  │              │  │              │  │              │           │
│  │ 1 CPU / 2Gi │  │ 1 CPU / 2Gi │  │ 1 CPU / 2Gi │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
└──────────────────────┼───────────────────────────────────────────┘
                       │
                 NATS JetStream
                       │
┌──────────────────────┼───────────────────────────────────────────┐
│              EXECUTION PLANE                                      │
│                                                                   │
│  ┌─────────────────────────┐  ┌────────────────────────────┐    │
│  │  Pi-session tool pods   │  │  Claude-code agent pods    │    │
│  │  (warm pool)            │  │  (on-demand per session)   │    │
│  │                         │  │                            │    │
│  │  Claimed per-turn       │  │  Full Agent SDK + CLI      │    │
│  │  Runs: bash, read_file, │  │  LLM calls via NATS proxy │    │
│  │    write_file, edit_file│  │  IPC tools via NATS        │    │
│  │  Ephemeral workspace    │  │  Ephemeral workspace       │    │
│  │  (git clone + GCS cache)│  │  (git clone + GCS cache)   │    │
│  │  runtimeClass: gvisor   │  │  runtimeClass: gvisor      │    │
│  │  No credentials         │  │  No credentials            │    │
│  │                         │  │                            │    │
│  │  Light: 1 CPU / 2Gi    │  │  Standard: 1 CPU / 2Gi    │    │
│  │  Heavy: 4 CPU / 16Gi   │  │  Heavy: 4 CPU / 16Gi      │    │
│  │  minReady: 2-3 (light) │  │  No warm pool (on-demand)  │    │
│  └─────────────────────────┘  └────────────────────────────┘    │
│                                                                   │
│  Deployment: pool-controller (1 replica)                          │
│    Maintains warm pool for pi-session tool pods                   │
│    Reconciliation loop: count ready → create/delete to target     │
└───────────────────────────────────────────────────────────────────┘
                       │
                 ┌─────┴─────┐
                 │ Cloud SQL │  PostgreSQL (HA, shared)
                 │           │
                 │ Tables:   │
                 │  messages  │  conversations  sessions
                 │  memory    │  audit          documents
                 │  agent_config               │
                 └───────────┘
```

---

## Component Details

### Host Pods (Ingress Layer)

**What they are:** Stateless HTTP servers behind a k8s Service/LoadBalancer. This is a thin version of the current `server.ts` — HTTP routing, SSE streaming, webhook handling, admin dashboard, and channel connections (Slack, Discord, etc).

**What they do:**
- Receive HTTP requests (`/v1/chat/completions`, `/webhooks/*`, `/admin/*`)
- Validate requests (auth, session ID, body parsing)
- Publish session requests to NATS (`session.request.{agentType}`)
- Subscribe to NATS EventBus for streaming events back to SSE clients
- Serve the admin dashboard (reads state from PostgreSQL + NATS events)
- Connect to channel providers (Slack, Discord) and forward inbound messages to NATS

**What they do NOT do:**
- Run agent conversation loops
- Make LLM API calls
- Spawn sandbox processes
- Hold any session state in memory (all state is in PostgreSQL)

**Key change from current `server.ts`:** The `processCompletion` call is replaced by a NATS publish + subscribe pattern. Instead of running the agent in-process, the host pod publishes the request and subscribes to the result/event subjects.

**Resources:** 0.5 CPU / 512Mi per pod. These are I/O-bound (HTTP + NATS + SSE) with minimal compute.

### Agent Runtime Pods (Conversation Plane)

**What they are:** The core of the system. These are the current AX server process minus the HTTP layer — they run the agent conversation loop, handle IPC from agent subprocesses, and dispatch tool calls.

**Internal structure:**

```
Agent Runtime Pod
  Parent Process (Node.js)
  ├── NATS Client
  │   ├── Subscribes: session.request.pi-session (queue group)
  │   ├── Subscribes: ipc.request.* (queue group, for claude-code callbacks)
  │   ├── Publishes: events.{requestId}, results.{requestId}
  │   └── Publishes: tasks.sandbox.{tier} (tool dispatch)
  │
  ├── IPC Server (Unix socket, per-subprocess)
  │   ├── In-process handlers:
  │   │   ├── llm_call → Anthropic API (pod has credentials)
  │   │   ├── memory_* → PostgreSQL
  │   │   ├── web_fetch → outbound HTTP
  │   │   ├── audit_* → PostgreSQL
  │   │   ├── identity_* → PostgreSQL (documents table)
  │   │   ├── skills_* → PostgreSQL (documents table)
  │   │   ├── workspace_write → PostgreSQL (documents table)
  │   │   └── agent_delegate → NATS (publish new session request)
  │   │
  │   └── NATS-dispatched handlers (NEW):
  │       ├── bash → publish to tasks.sandbox.light, await result
  │       ├── read_file → publish to tasks.sandbox.light, await result
  │       ├── write_file → publish to tasks.sandbox.light, await result
  │       └── edit_file → publish to tasks.sandbox.light, await result
  │
  ├── LLM Proxy (for claude-code sandbox pods)
  │   └── Subscribes: ipc.llm.{sessionId}, proxies to Anthropic API
  │
  └── Agent Subprocesses (spawned per session request)
      ├── pi-session subprocess 1 (IPC ↔ Unix socket)
      ├── pi-session subprocess 2 (IPC ↔ Unix socket)
      └── ...
```

**How a session request is handled:**

1. Agent runtime pod claims a `session.request.pi-session` message from NATS queue group
2. Parent process sets up workspace, loads history from PostgreSQL, creates IPC socket
3. Parent spawns `src/agent/runner.ts` subprocess (same as today)
4. Agent subprocess runs pi-session conversation loop
5. LLM calls go through IPC → parent handles in-process (calls Anthropic API directly)
6. Bash/file tool calls go through IPC → parent dispatches to sandbox pod via NATS
7. Parent streams events to NATS EventBus (`events.{requestId}`)
8. When agent subprocess exits, parent publishes final result to `results.{requestId}`
9. Parent saves conversation history to PostgreSQL

**Key changes from current `server.ts`:**
- Receives work from NATS instead of HTTP
- Bash/file IPC handlers dispatch to sandbox pods via NATS instead of running locally
- DB access uses PostgreSQL instead of SQLite
- Events go to NATS EventBus instead of in-process EventBus
- Identity/skills/workspace docs come from PostgreSQL documents table instead of filesystem

**Resources:** 1 CPU / 2Gi per pod. Multiple concurrent agent subprocesses per pod (I/O-bound, waiting on LLM/NATS).

### Sandbox Pods (Execution Plane)

Two types of sandbox pods serve different purposes:

#### Pi-Session Tool Pods (Warm Pool)

**Purpose:** Execute bash/file tool calls from pi-session agents.

**Lifecycle:**
1. Pool controller creates warm pods with the AX agent container image
2. Warm pod subscribes to `tasks.sandbox.light` (or `.heavy`) via NATS queue group
3. Pod claims a tool task from NATS
4. Pod sets up workspace (git clone or restore from GCS cache)
5. Pod executes the tool call (bash command, file read/write/edit)
6. Pod publishes result to `tasks.results.{sessionId}`
7. Pod is **retained for the duration of the conversation turn** — subsequent tool calls from the same turn reuse the same pod (avoids per-tool workspace setup)
8. When the turn ends (signaled via NATS), pod cleans up workspace and returns to warm pool (or exits if cross-tenant)

**Per-turn affinity:** The first tool call in a turn claims a warm pod and associates it with the `{requestId}`. Subsequent tool calls with the same `requestId` are routed to the same pod (via a NATS request/reply pattern with the pod's unique subject, not the queue group). This avoids re-cloning the workspace for every bash command.

**Tiered resources:**
- Light: 1 CPU / 2Gi — simple scripts, small data
- Heavy: 4 CPU / 16Gi — pandas, numpy, large datasets

**Security:**
- `runtimeClassName: gvisor` — kernel-level isolation
- No credentials — cannot call LLM or DB directly
- Network restricted to NATS only (k8s NetworkPolicy)
- Ephemeral workspace — wiped between tenants

#### Claude-Code Agent Pods (On-Demand)

**Purpose:** Run the full claude-code Agent SDK for sessions that use the claude-code runner.

**Lifecycle:**
1. Agent runtime pod receives a session request for `claude-code` runner type
2. Instead of spawning a local subprocess, it publishes to `tasks.sandbox.claude-code`
3. Pool controller (or the runtime itself) creates a new pod via the k8s API
4. Pod runs `src/agent/runner.ts --agent claude-code` with the full Agent SDK
5. Claude Code CLI executes with bash/file tools locally (the pod IS the sandbox)
6. LLM calls: Claude Code calls `ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT}` → local HTTP-to-NATS bridge → NATS `ipc.llm.{sessionId}` → agent runtime pod proxies to Anthropic → response via NATS
7. IPC tools (memory, web, audit): same pattern, via NATS `ipc.request.{sessionId}`
8. Pod streams events to NATS `events.{requestId}`
9. Pod publishes final result to `results.{requestId}`
10. Pod exits, k8s cleans up

**No warm pool:** Claude-code pods are on-demand. The cold start (pod scheduling + container start) adds ~5-10s, which is acceptable since claude-code sessions are long-running (minutes).

**HTTP-to-NATS bridge (in sandbox pod):**
```
Claude Code CLI
  → ANTHROPIC_BASE_URL=http://127.0.0.1:PORT
  → Local HTTP server (replaces current tcp-bridge.ts)
  → Publishes NATS request to ipc.llm.{sessionId}
  → Agent runtime pod claims request, proxies to Anthropic API
  → Response flows back via NATS reply
```

This preserves the security model: no API credentials in sandbox pods.

**Security:** Same as tool pods — gVisor, no credentials, NATS-only network.

### Pool Controller

**What it does:** Maintains the warm pool of pi-session tool pods.

```
Reconciliation loop (every 5 seconds):
  for each tier in [light, heavy]:
    ready = count pods with label tier={tier}, phase=warm
    if ready < tier.minReady:
      create (tier.minReady - ready) new pods
    if ready > tier.maxReady:
      delete (ready - tier.maxReady) newest idle pods
    emit metric: warm_pods_available{tier}
```

**Resources:** 0.25 CPU / 256Mi. Single replica, leader-elected.

---

## New Provider Abstractions

Three new providers, following AX's existing provider contract pattern (`create(config)` factory, registered in `provider-map.ts`).

### StorageProvider

Abstracts all database access currently spread across SQLite-backed classes (MessageQueue, ConversationStore, SessionStore, memory, audit, document storage).

```typescript
// src/providers/storage/types.ts

export interface StorageProvider {
  // Message queue
  messages: {
    enqueue(msg: { sessionId: string; channel: string; sender: string; content: string }): string;
    dequeue(): QueuedMessage | null;
    dequeueById(id: string): QueuedMessage | null;
    complete(id: string): void;
    fail(id: string): void;
  };

  // Conversation history
  conversations: {
    save(sessionId: string, role: string, content: string, sender?: string): void;
    load(sessionId: string, limit: number): StoredTurn[];
    saveSummary(sessionId: string, summary: string, summarizedUpTo: number): void;
  };

  // Session tracking
  sessions: {
    track(agentId: string, session: SessionAddress): void;
    getLatest(agentId: string, provider?: string): SessionAddress | null;
    listByAgent(agentId: string): SessionAddress[];
  };

  // Document storage (replaces filesystem for identity, skills, workspace, config)
  documents: {
    get(collection: string, key: string): string | null;
    set(collection: string, key: string, content: string): void;
    delete(collection: string, key: string): void;
    list(collection: string, prefix?: string): string[];
    getFile(collection: string, key: string): Buffer | null;
    setFile(collection: string, key: string, data: Buffer): void;
  };

  close(): void;
}
```

**Implementations:**
- `sqlite` — current behavior, wraps existing SQLite classes. For local dev.
- `postgresql` — Cloud SQL. Connection pool via `pg` or Kysely. For k8s.

**Provider map addition:**
```typescript
storage: {
  sqlite:     '../providers/storage/sqlite.js',
  postgresql: '../providers/storage/postgresql.js',
},
```

**Document collection naming convention:**
```
agents/{agentId}/identity/{fileName}    — SOUL.md, IDENTITY.md, AGENTS.md, etc.
agents/{agentId}/config/{key}           — capabilities.yaml, BOOTSTRAP.md, admins
agents/{agentId}/skills/{skillName}     — agent-level skills
agents/{agentId}/users/{userId}/skills/ — user-level skills
agents/{agentId}/users/{userId}/workspace/ — user workspace files
agents/{agentId}/agent/workspace/       — shared agent workspace files
```

### EventBusProvider

Abstracts the event bus for cross-pod event distribution.

```typescript
// src/providers/eventbus/types.ts

// Re-exports existing StreamEvent and EventListener types
export { StreamEvent, EventListener } from '../../host/event-bus.js';

export interface EventBusProvider {
  emit(event: StreamEvent): void;
  subscribe(listener: EventListener): () => void;
  subscribeRequest(requestId: string, listener: EventListener): () => void;
  listenerCount(): number;
  close(): void;
}
```

**Implementations:**
- `inprocess` — current `createEventBus()`. For local dev.
- `nats` — publishes to NATS subjects, subscribes via NATS. For k8s.

**NATS subject mapping:**
```
emit(event) → nats.publish(`events.${event.requestId}`, serialize(event))
              + nats.publish('events.global', serialize(event))

subscribeRequest(reqId, listener) → nats.subscribe(`events.${reqId}`)
subscribe(listener)               → nats.subscribe('events.global')
```

**Provider map addition:**
```typescript
eventbus: {
  inprocess: '../providers/eventbus/inprocess.js',
  nats:      '../providers/eventbus/nats.js',
},
```

### SandboxProvider: k8s-pod

New sandbox provider implementation that creates k8s pods instead of local Docker containers.

```typescript
// src/providers/sandbox/k8s-pod.ts

export async function create(config: Config): Promise<SandboxProvider> {
  // Uses @kubernetes/client-node to create pods
  // Pod template includes: gVisor runtime, resource limits, NATS sidecar config
  // Returns a SandboxProcess-compatible interface where:
  //   - stdin/stdout/stderr are NATS-backed streams
  //   - exitCode resolves when the pod completes
  //   - kill() deletes the pod
}
```

**Provider map addition:**
```typescript
sandbox: {
  subprocess: '../providers/sandbox/subprocess.js',
  seatbelt:   '../providers/sandbox/seatbelt.js',
  nsjail:     '../providers/sandbox/nsjail.js',
  bwrap:      '../providers/sandbox/bwrap.js',
  docker:     '../providers/sandbox/docker.js',
  'k8s-pod':  '../providers/sandbox/k8s-pod.js',    // NEW
},
```

---

## NATS Topology

### Streams

```
SESSIONS    — session request dispatch
  subjects: session.request.pi-session
             session.request.claude-code

TASKS       — sandbox tool dispatch
  subjects: tasks.sandbox.light
             tasks.sandbox.heavy
             tasks.sandbox.claude-code

RESULTS     — execution results (keyed by requestId)
  subjects: results.{requestId}

EVENTS      — streaming events (EventBus over NATS)
  subjects: events.{requestId}
             events.global

IPC         — sandbox-to-host callbacks (claude-code pods)
  subjects: ipc.request.{sessionId}
             ipc.llm.{sessionId}
```

### Consumer Groups

```
ax-agent-runtime        — queue group on session.request.*
                           (agent runtime pods compete for session requests)

sandbox-light-workers   — queue group on tasks.sandbox.light
                           (warm tool pods compete for tool tasks)

sandbox-heavy-workers   — queue group on tasks.sandbox.heavy
                           (heavy tool pods compete for heavy tasks)

ax-ipc-handlers         — queue group on ipc.request.*
                           (agent runtime pods compete for IPC callbacks)

ax-llm-proxy            — queue group on ipc.llm.*
                           (agent runtime pods compete for LLM proxy requests)
```

### Consumer Configuration

```
ack_wait: 600s              # Must exceed max execution timeout
max_deliver: 2              # One retry on failure
max_ack_pending: 1          # Each consumer processes one task at a time
deliver_policy: new         # Don't replay old tasks on pod restart
```

---

## Execution Flows

### Flow 1: Pi-Session Chat (No Code Execution)

User sends a message, agent responds with text only (no bash/file tools used).

```
1. Client → POST /v1/chat/completions → Host Pod A
2. Host Pod A:
   a. Validates request, extracts session_id, user_id
   b. Publishes to NATS: session.request.pi-session {
        requestId, sessionId, content, history, userId, agentConfig
      }
   c. Subscribes to NATS: events.{requestId} (for SSE streaming)
   d. Subscribes to NATS: results.{requestId} (for final result)

3. Agent Runtime Pod B claims the session request (queue group)
4. Agent Runtime Pod B:
   a. Loads conversation history from PostgreSQL
   b. Loads identity/skills/config from PostgreSQL documents
   c. Sets up IPC socket, spawns pi-session subprocess
   d. Agent subprocess runs LLM conversation loop
   e. LLM call → IPC → parent → Anthropic API (in-process, pod has credentials)
   f. Parent emits events to NATS EventBus: events.{requestId}
   g. Agent completes, subprocess exits
   h. Parent saves conversation turn to PostgreSQL
   i. Parent publishes: results.{requestId} { responseContent, finishReason }

5. Host Pod A:
   a. Receives events.{requestId} → forwards as SSE chunks to client
   b. Receives results.{requestId} → sends final SSE [DONE] or JSON response
```

**Latency:** ~same as today. The NATS publish/subscribe adds <5ms. LLM call is the bottleneck.

### Flow 2: Pi-Session With Bash/File Tools

User asks agent to write code, agent uses bash and file tools.

```
1-4a. Same as Flow 1 (up to agent subprocess starting)

4b. Agent LLM decides to use bash tool
4c. Agent subprocess calls bash via IPC → parent process
4d. Parent process:
    - First tool call in this turn: claim a warm sandbox pod
      Publishes to NATS: tasks.sandbox.light {
        requestId, sessionId, type: "claim",
        workspace: { gitUrl, ref, cacheKey }
      }
    - Warm pod claims task, sets up workspace (git clone or GCS cache restore)
    - Pod responds with its unique subject: sandbox.{podId}
    - Parent records the pod affinity for this requestId

4e. Parent dispatches bash command to claimed pod:
    Publishes to NATS: sandbox.{podId} {
      type: "bash", command: "npm test", cwd: "/workspace"
    }
4f. Sandbox pod executes command, publishes result:
    tasks.results.{sessionId} { stdout, stderr, exitCode }
4g. Parent receives result, returns to agent subprocess via IPC

4h. Agent LLM decides to use write_file tool (second tool call, same turn)
4i. Parent dispatches to SAME sandbox pod (per-turn affinity):
    Publishes to NATS: sandbox.{podId} {
      type: "write_file", path: "src/index.ts", content: "..."
    }
4j. Sandbox pod writes file, publishes result

4k. Agent completes turn
4l. Parent signals sandbox pod to release:
    Publishes to NATS: sandbox.{podId} { type: "release" }
4m. Sandbox pod pushes git changes (if any), cleans up, returns to warm pool
4n. Parent saves conversation, publishes final result
```

**Per-turn pod affinity** avoids re-cloning the workspace for every tool call. A typical turn might involve 5-10 tool calls — all go to the same pod with the same workspace state.

### Flow 3: Claude-Code Session

User connects with claude-code runner (e.g., from a CLI or API request specifying `model: "agent:main"` with claude-code config).

```
1. Client → POST /v1/chat/completions → Host Pod A
2. Host Pod A publishes to NATS: session.request.claude-code {
     requestId, sessionId, content, history, userId, agentConfig
   }

3. Agent Runtime Pod B claims the request
4. Agent Runtime Pod B:
   a. Creates a sandbox pod via k8s API (not from warm pool):
      - Image: ax/agent:latest
      - runtimeClass: gvisor
      - Resources: 1 CPU / 2Gi (or heavy tier)
      - Env: NATS_URL, SESSION_ID, REQUEST_ID
      - No API credentials
   b. Subscribes to NATS: ipc.request.{sessionId} (for IPC callbacks)
   c. Subscribes to NATS: ipc.llm.{sessionId} (for LLM proxy)

5. Claude-code sandbox pod starts:
   a. Runs src/agent/runner.ts --agent claude-code
   b. Sets up workspace (git clone)
   c. Starts local HTTP-to-NATS bridge on localhost:{PORT}
   d. Sets ANTHROPIC_BASE_URL=http://127.0.0.1:{PORT}
   e. Starts Agent SDK query()

6. During execution:
   a. Claude Code makes LLM API call:
      → HTTP to localhost:{PORT}
      → Bridge publishes NATS: ipc.llm.{sessionId}
      → Agent Runtime Pod B claims, proxies to Anthropic API
      → Response via NATS reply → bridge → Claude Code

   b. Claude Code uses bash/file tools: runs locally (pod IS the sandbox)

   c. Claude Code calls MCP tool (memory, web_search):
      → MCP server in sandbox → NATS: ipc.request.{sessionId}
      → Agent Runtime Pod B claims, handles in-process
      → Response via NATS reply

   d. Sandbox pod emits streaming events:
      → NATS: events.{requestId}
      → Host Pod A forwards to SSE client

7. Claude Code completes:
   a. Sandbox pod publishes: results.{requestId}
   b. Sandbox pod pushes git changes, exits
   c. K8s cleans up pod
   d. Agent Runtime Pod B saves conversation, unsubscribes
```

### Flow 4: Agent Delegation

Agent delegates a subtask to another agent.

```
1. Parent agent (pi-session) calls agent_delegate IPC tool
2. Agent runtime pod handles delegation:
   a. Publishes new session request to NATS:
      session.request.{childRunnerType} {
        requestId: childRequestId,
        task, context, parentSessionId
      }
   b. Registers orchestrator handle (tracked in PostgreSQL)

3. Another agent runtime pod (or same one) claims the child request
4. Child agent runs (same as Flow 1 or 2)
5. Child completes, publishes: results.{childRequestId}

6. Parent agent runtime pod:
   a. Receives child result via NATS
   b. Returns result to parent agent subprocess via IPC
   c. Parent agent continues processing
```

---

## Security Model

| Layer | Mechanism | Protects Against |
|---|---|---|
| Pod isolation (gVisor) | Each code execution in its own gVisor pod | Cross-tenant data access, kernel exploits, container escapes |
| No credentials in sandbox | LLM calls proxied via NATS through agent runtime pods | Credential theft from compromised sandbox |
| Network policy | Sandbox pods can only reach NATS (k8s NetworkPolicy) | Unauthorized network access, data exfiltration |
| NATS tenant tagging | Every task carries `tenant_id`; sandbox pods validate before executing | Tenant impersonation, task hijacking |
| No cross-tenant pod reuse | Pods exit after serving a tenant (or recycle only within same tenant) | Data residue between tenants |
| Subprocess hardening (in-pod) | Separate UID, rlimits in sandbox pods | Defense-in-depth within sandbox |
| Per-turn workspace isolation | Workspace wiped between tenants, git clone per turn | Cross-session data leakage |
| Execution timeouts | Hard timeout per task, enforced by sandbox pod supervisor | Resource exhaustion, infinite loops |
| IPC validation | All IPC actions validated via Zod schemas with `.strict()` mode | Injection, unauthorized actions |
| Tool restriction | Pi-session sandbox pods: only bash/file tools. No LLM, no memory, no web. | Privilege escalation |

### NetworkPolicy for Sandbox Pods

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: sandbox-restrict
spec:
  podSelector:
    matchLabels:
      ax.io/plane: execution
  policyTypes: [Ingress, Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app: nats
      ports:
        - port: 4222      # NATS client
    # DNS for NATS service discovery
    - to: []
      ports:
        - port: 53
          protocol: UDP
  ingress: []               # No inbound connections
```

---

## Workspace & Storage Strategy

### Ephemeral Workspaces With Git as Persistence

Sandbox pods get fast local disk. Workspaces are ephemeral — git is the persistence layer.

**Per-turn lifecycle:**
1. Sandbox pod starts → local SSD available at `/workspace`
2. Restore workspace:
   - Check GCS cache: `gs://ax-workspace-cache/{repoHash}/workspace.tar.gz`
   - If cached: download + extract (~5-10s for a few hundred MB)
   - If not cached: `git clone {repoUrl} --depth=1` (~10-30s depending on repo size)
   - Restore dependency cache: `gs://ax-workspace-cache/{lockfileHash}/node_modules.tar.gz`
3. Execute tool calls (bash, file read/write) — fast local I/O
4. On turn completion:
   - `git add . && git commit && git push` (if changes exist)
   - Update GCS cache (async, non-blocking)
5. On pod release: workspace is wiped (or pod exits)

**GCS cache keys:**
```
gs://ax-workspace-cache/
  {sha256(repoUrl+branch)}/
    workspace.tar.gz          — .git directory + working tree
    workspace.meta.json       — { commitSha, cachedAt, size }
  {sha256(lockfileContent)}/
    node_modules.tar.gz       — dependency cache (like CI)
```

### Document Storage in PostgreSQL

Identity files, skills, config, and small workspace files are stored as rows in PostgreSQL (via the StorageProvider). This data is small (KBs), frequently read, and needs to be shared across all pods.

```sql
CREATE TABLE documents (
  collection  TEXT NOT NULL,     -- e.g. 'agents/main/identity'
  key         TEXT NOT NULL,     -- e.g. 'SOUL.md'
  content     TEXT,              -- text content
  data        BYTEA,            -- binary content (images, etc.)
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (collection, key)
);

CREATE INDEX idx_documents_collection ON documents(collection);
```

---

## Observability

### Metrics (Prometheus)

```
# Host pods
ax_http_requests_total{method, path, status}
ax_http_request_duration_seconds{method, path}
ax_sse_connections_active{}

# Agent runtime pods
ax_sessions_active{}
ax_session_duration_seconds{runner_type}
ax_llm_call_duration_seconds{model}
ax_tool_dispatch_duration_seconds{tool, tier}
ax_ipc_handler_duration_seconds{action}

# Sandbox pods
ax_sandbox_claim_latency_seconds{tier}
ax_sandbox_execution_duration_seconds{tier, tool}
ax_sandbox_status_total{status="success|failure|timeout|oom"}

# Pool controller
ax_warm_pods_available{tier}
ax_warm_pods_target{tier}
ax_pod_startup_latency_seconds{tier}

# NATS
ax_nats_publish_latency_seconds{subject}
ax_nats_consumer_pending{consumer}
```

### Tracing (OpenTelemetry / Langfuse)

```
Trace: user_request
  └── Span: host.http_request
       └── Span: nats.session_dispatch
            └── Span: agent_runtime.process_completion
                 ├── Span: llm_call (model, tokens, latency)
                 ├── Span: tool_call:bash
                 │    ├── Span: nats.sandbox_dispatch (tier, claim_latency)
                 │    └── Span: sandbox.execute (command, duration, exit_code)
                 ├── Span: tool_call:write_file
                 │    └── Span: sandbox.execute (path, duration)
                 └── Span: tool_call:agent_delegate
                      └── Span: child_agent (recursive)
```

### Structured Logging

All components use the existing `getLogger()` with structured JSON output. In k8s, logs are collected via Cloud Logging (stdout/stderr from all pods).

---

## Phased Implementation

### Phase 1: Provider Abstractions (No K8s Yet)

**Goal:** Create the StorageProvider and EventBusProvider abstractions with local implementations. AX continues to work exactly as today, but the infrastructure dependencies are pluggable.

**Tasks:**

1. **StorageProvider interface + SQLite implementation**
   - Define `StorageProvider` in `src/providers/storage/types.ts`
   - Create `src/providers/storage/sqlite.ts` wrapping existing MessageQueue, ConversationStore, SessionStore
   - Add document storage to SQLite (new table for identity/skills/config)
   - Add to provider-map.ts
   - Refactor `server.ts` to use `providers.storage` instead of direct SQLite classes
   - Migrate filesystem reads/writes (identity, skills, admins) to go through `providers.storage.documents`

2. **EventBusProvider interface + InProcess implementation**
   - Define `EventBusProvider` in `src/providers/eventbus/types.ts`
   - Wrap existing `createEventBus()` as the `inprocess` provider
   - Add to provider-map.ts, Config type, ProviderRegistry
   - Refactor all `eventBus` usage to go through `providers.eventbus`

3. **Move bash/file tools from local to IPC**
   - Add `bash`, `read_file`, `write_file`, `edit_file` to the IPC tool catalog (`tool-catalog.ts`)
   - Create IPC handlers for these tools in `src/host/ipc-handlers/sandbox-tools.ts`
   - In local mode, IPC handlers execute locally (same as `createLocalTools` does today)
   - Remove `createLocalTools` from the agent — all tools are now IPC tools
   - Agent subprocess no longer needs direct filesystem access to workspace

**Validation:** `npm test` passes. `ax start` works identically. No behavioral changes.

### Phase 2: PostgreSQL + NATS Providers

**Goal:** Add PostgreSQL and NATS implementations for the provider abstractions.

**Tasks:**

4. **PostgreSQL StorageProvider implementation**
   - Create `src/providers/storage/postgresql.ts`
   - Schema migrations for all tables (messages, conversations, sessions, documents)
   - Connection pool configuration
   - Integration tests against a local PostgreSQL (Docker)

5. **NATS EventBusProvider implementation**
   - Create `src/providers/eventbus/nats.ts`
   - Subject mapping: `events.{requestId}`, `events.global`
   - Connection management, reconnection
   - Integration tests against a local NATS server

6. **NATS-based IPC for sandbox tool dispatch**
   - Create NATS publish/subscribe logic for bash/file IPC handlers
   - When `sandbox` provider is `k8s-pod`, tool IPC handlers dispatch via NATS instead of executing locally
   - Create sandbox worker process (`src/sandbox-worker/worker.ts`) that subscribes to NATS, executes tools, publishes results

7. **k8s-pod SandboxProvider**
   - Create `src/providers/sandbox/k8s-pod.ts`
   - Pod template generation (gVisor, resource limits, NATS env)
   - Pod lifecycle management (create, monitor, cleanup)
   - Integration tests against minikube/kind

**Validation:** Integration tests pass with PostgreSQL and NATS. Local dev still works with SQLite and in-process EventBus.

### Phase 3: K8s Deployment

**Goal:** Deploy the full three-layer architecture on GKE Autopilot.

**Tasks:**

8. **K8s manifests**
   - `k8s/host.yaml` — Deployment, Service, Ingress
   - `k8s/agent-runtime.yaml` — Deployment
   - `k8s/sandbox-light.yaml` — Pod template for warm pool
   - `k8s/sandbox-heavy.yaml` — Pod template for heavy tier
   - `k8s/nats-cluster.yaml` — StatefulSet with JetStream
   - `k8s/pool-controller.yaml` — Deployment
   - `k8s/network-policies.yaml` — Sandbox network restrictions
   - `k8s/cloud-sql-proxy.yaml` — Sidecar for Cloud SQL access

9. **Pool controller**
   - `src/pool-controller/controller.ts` — Reconciliation loop
   - `src/pool-controller/metrics.ts` — Prometheus endpoint
   - `src/pool-controller/k8s-client.ts` — Pod CRUD

10. **Sandbox worker**
    - `src/sandbox-worker/worker.ts` — NATS consumer, tool execution
    - `src/sandbox-worker/workspace.ts` — Git clone, GCS cache restore
    - Container image: builds on existing `container/Dockerfile`

11. **Host pod refactor**
    - Extract HTTP handling from `server.ts` into standalone host process
    - NATS-based session dispatch (instead of in-process `processCompletion`)
    - SSE streaming via NATS EventBus subscription

12. **Agent runtime pod refactor**
    - Extract agent spawning from `server.ts` into standalone runtime process
    - NATS-based session claiming (queue group subscriber)
    - NATS-based tool dispatch for bash/file IPC handlers
    - NATS-based LLM proxy for claude-code pods

13. **HTTP-to-NATS bridge for claude-code**
    - Replace `tcp-bridge.ts` with NATS-based bridge
    - Local HTTP server in sandbox pod → NATS request/reply → agent runtime LLM proxy

**Validation criteria:**
- Warm pod claim latency < 100ms
- Code execution round-trip works end-to-end
- gVisor pods start and connect to NATS reliably
- Pool controller maintains target warm pod count under load
- Cross-tenant isolation verified
- Streaming SSE works across pod boundaries
- Claude-code LLM proxy via NATS works end-to-end

### Phase 4: Heavy Tier + Scaling

**Goal:** Add heavyweight execution tier and auto-scaling.

**Tasks:**
- Heavy tier pool (4 CPU / 16Gi, Performance compute class)
- Tier classification logic (heuristic: check imports, data_ref sizes)
- Speculative pre-warming (detect large dataset upload → create heavy pod)
- KEDA ScaledObject for NATS queue depth scaling
- CronJob for off-hours scale-down (heavy minReady: 0 off-hours, 1 business hours)

### Phase 5: Task Graph Scheduler (Future)

Only when concrete multi-step workflows require it. Not in initial scope.

---

## Migration from Current Architecture

### What Changes

| Component | Current | K8s |
|---|---|---|
| HTTP server | Single process, Unix socket + TCP | Host pods behind LoadBalancer |
| Agent spawning | `processCompletion` → sandbox subprocess | NATS dispatch → agent runtime pod → subprocess |
| Sandbox | Docker/bwrap/subprocess (local) | k8s-pod provider (creates gVisor pods) |
| Bash/file tools | Local execution in sandbox subprocess | IPC → NATS → sandbox pod |
| LLM calls | In-process (host) or IPC proxy | In-process (agent runtime pod) or NATS proxy (claude-code) |
| EventBus | In-process pub/sub | NATS JetStream |
| Database | SQLite files under ~/.ax/data/ | Cloud SQL (PostgreSQL) |
| Identity/skills/config | Filesystem under ~/.ax/agents/ | PostgreSQL documents table |
| Workspaces | Local persistent directories | Ephemeral local + git + GCS cache |
| IPC | Unix domain socket | Unix socket (within pod) + NATS (cross-pod) |

### What Stays the Same

- Agent subprocess code (`src/agent/runner.ts`, `pi-session.ts`, `claude-code.ts`) — unchanged
- IPC protocol and Zod schemas — unchanged (transport changes, protocol doesn't)
- Tool catalog — unchanged (new tools added for bash/file IPC, old local tools removed)
- Provider contract pattern — unchanged (new providers follow the same `create(config)` pattern)
- Config structure (`ax.yaml`) — extended with new provider names, not restructured
- LLM provider, channel providers, web provider, scanner — unchanged
- Security model — strengthened (pod isolation replaces in-process isolation)

### Backwards Compatibility

The provider abstraction ensures backwards compatibility:

```yaml
# ax.yaml — local dev (unchanged)
providers:
  storage: sqlite
  eventbus: inprocess
  sandbox: docker        # or subprocess, bwrap, etc.

# ax.yaml — k8s deployment
providers:
  storage: postgresql
  eventbus: nats
  sandbox: k8s-pod
```

`ax start` on a developer laptop continues to work with SQLite, in-process EventBus, and local sandbox providers. No k8s dependency for local development.

---

## Cost Model

```
Ingress layer:
  2-3 host pods × 0.5 CPU / 512Mi = 1-1.5 CPU, 1-1.5Gi always-on
  Cost: minimal

Conversation plane:
  3-5 agent runtime pods × 1 CPU / 2Gi = 3-5 CPU, 6-10Gi always-on
  Cost: low, stable

Execution plane (lightweight):
  2-3 warm pods × 1 CPU / 2Gi = 2-3 CPU, 4-6Gi always-on
  Burst pods: 0-20 depending on load, short-lived (seconds to minutes)
  Cost: small base + usage-proportional

Execution plane (heavyweight, Phase 4):
  0-1 warm pods × 4 CPU / 16Gi = 0-4 CPU, 0-16Gi (scales to zero off-hours)
  Cost: near-zero when idle

NATS:
  3-pod cluster × 0.5 CPU / 1Gi = 1.5 CPU, 3Gi
  Cost: low

Cloud SQL (PostgreSQL):
  db-f1-micro for dev, db-custom-2-7680 for production
  Cost: $50-150/mo depending on tier

Total baseline: ~8-13 CPU, ~15-22Gi RAM
Peak (heavy load): ~30-50 CPU, ~100-150Gi RAM
```

---

## Helm Chart + FluxCD GitOps

### Overview

The raw k8s manifests from Phase 3 (tasks 8-13) have been replaced by a Helm chart at `charts/ax/` with FluxCD GitOps at `flux/`. The raw manifests are preserved at `k8s/archive/` for reference.

### Key Design Decision: ConfigMap-Mounted ax.yaml

Instead of scattering configuration across env vars in each deployment, the Helm chart renders `.Values.config` as a full `ax.yaml` ConfigMap. Every pod mounts this at `/etc/ax/ax.yaml` and sets `AX_CONFIG_PATH=/etc/ax/ax.yaml`. This reuses the existing `loadConfig()` code path — no changes to `config.ts` were needed.

Two small code changes support this:
- `src/paths.ts`: `configPath()` respects `AX_CONFIG_PATH` env var
- `src/pool-controller/main.ts`: `loadTierConfigs()` reads tier configs from JSON files when `SANDBOX_TEMPLATE_DIR` is set

### Chart Structure

```
charts/ax/
├── Chart.yaml                    # NATS + PostgreSQL subchart dependencies
├── values.yaml                   # Single source of truth for all config
├── templates/
│   ├── _helpers.tpl              # ax.fullname, ax.image, ax.natsUrl, etc.
│   ├── configmap-ax-config.yaml  # Renders .Values.config as ax.yaml
│   ├── nats-stream-init-job.yaml # Post-install hook: creates 5 JetStream streams
│   ├── host/
│   │   ├── deployment.yaml       # Checksum annotation for rolling restart
│   │   ├── service.yaml
│   │   └── ingress.yaml          # Conditional on host.ingress.enabled
│   ├── agent-runtime/
│   │   ├── deployment.yaml       # ANTHROPIC_API_KEY from secret, 600s grace
│   │   ├── serviceaccount.yaml
│   │   ├── role.yaml             # Pod CRUD for sandbox management
│   │   └── rolebinding.yaml
│   ├── pool-controller/
│   │   ├── deployment.yaml       # SANDBOX_TEMPLATE_DIR=/etc/ax/sandbox-templates
│   │   ├── configmap-sandbox-templates.yaml  # light.json + heavy.json
│   │   ├── serviceaccount.yaml
│   │   ├── role.yaml
│   │   └── rolebinding.yaml
│   └── networkpolicies/
│       ├── sandbox-restrict.yaml       # NATS + DNS only
│       ├── agent-runtime-network.yaml  # NATS + PostgreSQL + HTTPS + DNS
│       └── host-network.yaml           # Inbound HTTP + NATS + PostgreSQL + HTTPS + DNS
```

### FluxCD Structure

```
.sops.yaml                        # SOPS encryption rules (age keys)
flux/
├── sources/
│   ├── git-repository.yaml       # GitRepository pointing to this repo
│   └── helm-repository-nats.yaml # HelmRepository for nats-io charts
├── base/
│   └── kustomization.yaml        # Reconciles sources
├── staging/
│   ├── flux-kustomization.yaml
│   └── helm-release.yaml         # 1 host, 2 agent-runtime, no HPA, balanced
└── production/
    ├── flux-kustomization.yaml
    └── helm-release.yaml         # 2+ host, 3+ agent-runtime, HPA, TLS, paranoid
```

### PostgreSQL: Vendor-Agnostic

The chart accepts any PostgreSQL connection URL via a k8s Secret (`postgresql.external.existingSecret`). No vendor-specific proxy is bundled — users deploy Cloud SQL Auth Proxy, RDS Proxy, or pgBouncer separately as needed. Network policies allow generic PostgreSQL egress on port 5432.

### Subcharts

- **NATS** (`nats-io/nats`): Conditional on `nats.enabled`. JetStream with configurable replicas, memory/file store sizes.
- **PostgreSQL** (`bitnami/postgresql`): Conditional on `postgresql.internal.enabled`. For self-hosted/dev environments. Production uses external PostgreSQL.

### Sandbox Templates

Sandbox tier configs (CPU, memory, image, command) are Helm-configurable via `.Values.sandbox.tiers`, rendered as JSON files in a ConfigMap mounted at `/etc/ax/sandbox-templates/`. Security context (gVisor runtime, `readOnlyRootFilesystem`, `drop ALL` capabilities, `runAsNonRoot`) remains hardcoded in `k8s-client.ts:createPod()` — never configurable.
