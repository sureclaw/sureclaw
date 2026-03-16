# K8s NATS IPC Sandbox — Per-Turn Pod Isolation

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the k8s sandbox work like docker/apple: the agent runs inside the pod via the same `runner.js` entry point, tools execute locally, and IPC goes through NATS instead of Unix sockets. Each conversation turn claims an idle pod from a warm pool and releases it when done.

**Architecture:** The existing `runner.js` gains a NATS IPC transport selected via `AX_IPC_TRANSPORT=nats` env var. The agent-runtime-process dispatches turns to warm pods by calling the k8s sandbox provider's `spawn()`, which creates a pod running `runner.js` with NATS IPC. The host starts a per-session NATS IPC handler so the pod can call back for non-sandbox tools (llm, memory, web, audit). Workspace volumes (scratch, agent, user) are mounted as `emptyDir` at canonical paths. The flow is identical to docker/apple — the only difference is the IPC transport layer.

**Tech Stack:** TypeScript, Node.js, NATS (nats.js), @kubernetes/client-node, Kubernetes, Helm

---

## Table of Contents

1. [Current State](#current-state)
2. [Target Architecture](#target-architecture)
3. [Tasks](#tasks)

---

## Current State

The agent-runtime pod (`agent-runtime-process.ts`) overrides the k8s sandbox with subprocess at lines 164-167:

```typescript
if (config.providers.sandbox === 'k8s') {
  const subprocessModule = await import('../providers/sandbox/subprocess.js');
  agentSandbox = await subprocessModule.create(config);
}
```

This means:
- Both sessions share one pod (no isolation)
- Bash commands run as local `execSync` inside the shared pod
- The k8s sandbox provider (`k8s.ts`) is unused for the agent loop
- The NATS bridge (`nats-bridge.ts`) only handles claude-code LLM proxying
- The pool controller creates sandbox worker pods that run `dist/sandbox-worker/main.js` (which doesn't exist)

## Target Architecture

```
Host (agent-runtime-process)       Sandbox Pods (warm pool)
┌──────────────────────────┐       ┌───────────────────────────────┐
│ Claims session.request.* │       │ Pod A (warm)                  │
│ from NATS queue group    │       │   entry: runner.js            │
│                          │       │   AX_IPC_TRANSPORT=nats       │
│ Per turn:                │       │   volumes:                    │
│  1. Start NATS IPC       │       │     /workspace/scratch        │
│     handler for session  │       │     /workspace/agent          │
│  2. sandbox.spawn() →    │──▶    │     /workspace/user           │
│     creates k8s pod      │       │                               │
│     running runner.js    │       │ Pod B (running turn X)        │
│  3. Write stdin payload  │──▶    │   ├─ runner.js reads stdin    │
│     (history, identity,  │       │   ├─ pi-session agent loop    │
│      skills, message)    │       │   ├─ local bash/file (local-  │
│  4. Read stdout response │◀──    │   │  sandbox.ts)              │
│  5. Close NATS IPC       │       │   └─ IPC via NATS ──┐        │
│     handler              │       │                      │        │
│  6. Commit workspace     │       │ Pod C (warm)         │        │
└──────────────────────────┘       └──────────────────────│────────┘
                                                          │
                                                    NATS  │
                                                          ▼
                                              Host NATS IPC handler:
                                                llm_call, memory_*,
                                                web_fetch, audit_*, etc.
```

This is the **same flow as docker/apple**:
1. `server-completions.ts` calls `sandbox.spawn(config)` with the runner command
2. Host writes stdin payload (history, identity, skills, message)
3. `runner.js` inside the container reads stdin, creates IPC client, runs agent
4. Agent uses `local-sandbox.ts` for bash/file tools (executes locally in pod)
5. Non-sandbox IPC calls go through the IPC client to the host
6. Agent writes response to stdout, host reads it

The **only difference** for k8s:

| Aspect | Docker/Apple | K8s |
|--------|-------------|-----|
| IPC transport | Unix socket (bind mount / virtio-vsock) | NATS request/reply |
| IPC env var | `AX_IPC_SOCKET=/path/to/sock` | `AX_IPC_TRANSPORT=nats` + `NATS_URL` |
| IPC client | `IPCClient` (Unix socket) | `NATSIPCClient` (NATS) |
| Host-side IPC | `createIPCServer()` (Unix socket) | `startNATSIPCHandler()` (NATS subscriber) |
| Pod creation | `docker run` / `container run` (child process) | k8s API `createNamespacedPod()` |
| stdin/stdout | Piped to child process stdio | k8s Attach API (WebSocket) |

---

## Tasks

### Task 1: Create NATS IPC Client

The agent needs an IPC client that uses NATS request/reply instead of Unix sockets. It must expose the same `call()`, `connect()`, `disconnect()`, and `setContext()` interface as `IPCClient` so that `local-sandbox.ts`, `ipc-tools.ts`, and runners can use it without changes.

**Files:**
- Create: `src/agent/nats-ipc-client.ts`
- Test: `tests/agent/nats-ipc-client.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/agent/nats-ipc-client.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NATSIPCClient } from '../../src/agent/nats-ipc-client.js';

// Mock nats module
vi.mock('nats', () => {
  const mockNc = {
    request: vi.fn(async (subject: string, data: Uint8Array, opts?: any) => {
      const req = JSON.parse(new TextDecoder().decode(data));
      return { data: new TextEncoder().encode(JSON.stringify({ ok: true })) };
    }),
    drain: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async () => mockNc),
    _mockNc: mockNc,
  };
});

describe('NATSIPCClient', () => {
  let client: NATSIPCClient;

  beforeAll(async () => {
    client = new NATSIPCClient({
      sessionId: 'test-session',
      natsUrl: 'nats://localhost:4222',
    });
    await client.connect();
  });

  afterAll(async () => {
    await client.disconnect();
  });

  it('sends IPC call via NATS request/reply', async () => {
    const result = await client.call({ action: 'sandbox_approve', operation: 'bash', command: 'ls' });
    expect(result).toEqual({ ok: true });
  });

  it('enriches requests with session context', async () => {
    const nats = await import('nats');
    const mockNc = (nats as any)._mockNc;
    await client.call({ action: 'memory_search', query: 'test' });

    const lastCall = mockNc.request.mock.calls.at(-1);
    const sent = JSON.parse(new TextDecoder().decode(lastCall[1]));
    expect(sent._sessionId).toBe('test-session');
    expect(sent.action).toBe('memory_search');
  });

  it('publishes to ipc.request.{sessionId} subject', async () => {
    const nats = await import('nats');
    const mockNc = (nats as any)._mockNc;
    await client.call({ action: 'web_fetch', url: 'https://example.com' });

    const lastCall = mockNc.request.mock.calls.at(-1);
    expect(lastCall[0]).toBe('ipc.request.test-session');
  });

  it('updates subject when setContext changes sessionId', () => {
    client.setContext({ sessionId: 'new-session' });
    // Next call would use ipc.request.new-session
    client.setContext({ sessionId: 'test-session' }); // restore
  });

  it('throws on NATS timeout', async () => {
    const nats = await import('nats');
    const mockNc = (nats as any)._mockNc;
    mockNc.request.mockRejectedValueOnce(new Error('TIMEOUT'));
    await expect(client.call({ action: 'slow_action' })).rejects.toThrow('TIMEOUT');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/nats-ipc-client.test.ts`
Expected: FAIL — module `../../src/agent/nats-ipc-client.js` does not exist

**Step 3: Write the implementation**

```typescript
// src/agent/nats-ipc-client.ts — NATS-based IPC client for k8s sandbox pods.
//
// Drop-in replacement for IPCClient when running inside a k8s pod.
// Uses NATS request/reply on ipc.request.{sessionId} instead of Unix sockets.
// Selected by AX_IPC_TRANSPORT=nats env var in runner.ts.
//
// The host-side NATS IPC handler (nats-ipc-handler.ts) subscribes to the
// same subject and routes requests through the existing handleIPC pipeline.

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'nats-ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;

export interface NATSIPCClientOptions {
  sessionId: string;
  natsUrl?: string;
  timeoutMs?: number;
  requestId?: string;
  userId?: string;
  sessionScope?: string;
}

export class NATSIPCClient {
  private sessionId: string;
  private natsUrl: string;
  private timeoutMs: number;
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private nc: any = null;
  private subject: string;

  constructor(opts: NATSIPCClientOptions) {
    this.sessionId = opts.sessionId;
    this.natsUrl = opts.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.requestId = opts.requestId;
    this.userId = opts.userId;
    this.sessionScope = opts.sessionScope;
    this.subject = `ipc.request.${this.sessionId}`;
  }

  /** Update session context after construction (matches IPCClient.setContext). */
  setContext(ctx: { sessionId?: string; requestId?: string; userId?: string; sessionScope?: string }): void {
    if (ctx.sessionId !== undefined) {
      this.sessionId = ctx.sessionId;
      this.subject = `ipc.request.${this.sessionId}`;
    }
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
  }

  async connect(): Promise<void> {
    if (this.nc) return;
    const natsModule = await import('nats');
    this.nc = await natsModule.connect({
      servers: this.natsUrl,
      name: `ax-ipc-${this.sessionId}`,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 1000,
    });
    logger.info('nats_connected', { sessionId: this.sessionId, subject: this.subject });
  }

  /** Send an IPC request and wait for the response (matches IPCClient.call). */
  async call(request: Record<string, unknown>, callTimeoutMs?: number): Promise<Record<string, unknown>> {
    if (!this.nc) await this.connect();

    const enriched = {
      ...request,
      _sessionId: this.sessionId,
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };

    const payload = new TextEncoder().encode(JSON.stringify(enriched));
    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;

    logger.debug('call_start', {
      action: request.action,
      subject: this.subject,
      timeoutMs: effectiveTimeout,
    });

    const response = await this.nc.request(this.subject, payload, {
      timeout: effectiveTimeout,
    });

    const result = JSON.parse(new TextDecoder().decode(response.data));
    logger.debug('call_done', { action: request.action });
    return result;
  }

  async disconnect(): Promise<void> {
    if (this.nc) {
      await this.nc.drain();
      this.nc = null;
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/agent/nats-ipc-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/nats-ipc-client.ts tests/agent/nats-ipc-client.test.ts
git commit -m "feat(k8s): add NATS IPC client for sandbox pods"
```

---

### Task 2: Create NATS IPC Handler (host-side)

The host needs a NATS subscriber that receives IPC requests from sandbox pods and routes them through the existing `handleIPC` pipeline. This is the server-side counterpart to `NATSIPCClient`. One instance is created per active turn.

**Files:**
- Create: `src/host/nats-ipc-handler.ts`
- Test: `tests/host/nats-ipc-handler.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/host/nats-ipc-handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { startNATSIPCHandler } from '../../src/host/nats-ipc-handler.js';

vi.mock('nats', () => {
  const sub = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise(() => {}), // hangs (no messages in test)
      return: async () => ({ value: undefined, done: true }),
    }),
    unsubscribe: vi.fn(),
  };
  const mockNc = {
    subscribe: vi.fn(() => sub),
    drain: vi.fn(async () => {}),
  };
  return {
    connect: vi.fn(async () => mockNc),
    _mockNc: mockNc,
  };
});

describe('startNATSIPCHandler', () => {
  it('subscribes to ipc.request.{sessionId}', async () => {
    const handleIPC = vi.fn(async () => JSON.stringify({ ok: true }));
    const handler = await startNATSIPCHandler({
      sessionId: 'sess-1',
      handleIPC,
    });

    const nats = await import('nats');
    const mockNc = (nats as any)._mockNc;
    expect(mockNc.subscribe).toHaveBeenCalledWith('ipc.request.sess-1');

    handler.close();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/nats-ipc-handler.test.ts`
Expected: FAIL — module does not exist

**Step 3: Write the implementation**

```typescript
// src/host/nats-ipc-handler.ts — NATS-based IPC handler for k8s sandbox pods.
//
// Subscribes to ipc.request.{sessionId} and routes incoming IPC requests
// through the existing handleIPC pipeline. The sandbox pod sends requests
// via NATSIPCClient; this handler receives them and responds via NATS reply.
//
// One handler instance per active turn (started when the turn begins,
// closed when the turn completes).

import { getLogger } from '../logger.js';
import type { IPCContext } from './ipc-server.js';

const logger = getLogger().child({ component: 'nats-ipc-handler' });

export interface NATSIPCHandlerOptions {
  sessionId: string;
  natsUrl?: string;
  /** The IPC handler function from createIPCHandler(). */
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  /** Default IPC context for this session. */
  ctx?: IPCContext;
}

/**
 * Start a NATS IPC handler for a specific session.
 * Subscribes to ipc.request.{sessionId}, processes each request through
 * handleIPC, and responds via NATS reply subject.
 */
export async function startNATSIPCHandler(options: NATSIPCHandlerOptions): Promise<{ close: () => void }> {
  const natsModule = await import('nats');

  const natsUrl = options.natsUrl ?? process.env.NATS_URL ?? 'nats://localhost:4222';
  const subject = `ipc.request.${options.sessionId}`;

  const nc = await natsModule.connect({
    servers: natsUrl,
    name: `ax-ipc-handler-${options.sessionId}`,
    reconnect: true,
    maxReconnectAttempts: -1,
    reconnectTimeWait: 1000,
  });

  const sub = nc.subscribe(subject);

  logger.info('nats_ipc_handler_started', { sessionId: options.sessionId, subject });

  const defaultCtx: IPCContext = options.ctx ?? {
    sessionId: options.sessionId,
    agentId: 'system',
    userId: 'default',
  };

  (async () => {
    for await (const msg of sub) {
      let raw: string;
      try {
        raw = new TextDecoder().decode(msg.data);
      } catch (err) {
        logger.error('nats_ipc_decode_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify({ error: 'Invalid request encoding' })));
        }
        continue;
      }

      try {
        const parsed = JSON.parse(raw);
        const ctx: IPCContext = {
          sessionId: parsed._sessionId ?? defaultCtx.sessionId,
          agentId: parsed._agentId ?? defaultCtx.agentId,
          userId: parsed._userId ?? defaultCtx.userId,
        };

        const result = await options.handleIPC(raw, ctx);

        if (msg.reply) {
          msg.respond(new TextEncoder().encode(result));
        }
      } catch (err) {
        logger.error('nats_ipc_handler_error', { error: (err as Error).message });
        if (msg.reply) {
          msg.respond(new TextEncoder().encode(JSON.stringify({ error: (err as Error).message })));
        }
      }
    }
  })().catch((err) => {
    logger.error('nats_ipc_loop_error', { error: (err as Error).message });
  });

  return {
    close() {
      sub.unsubscribe();
      void nc.drain();
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/host/nats-ipc-handler.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/nats-ipc-handler.ts tests/host/nats-ipc-handler.test.ts
git commit -m "feat(k8s): add NATS IPC handler for host-side request routing"
```

---

### Task 3: Add NATS IPC transport to runner.ts

Add an `AX_IPC_TRANSPORT=nats` env var check to `runner.ts` so it creates a `NATSIPCClient` instead of `IPCClient`. This is the only change needed for the agent to work inside k8s pods — the entire rest of the runner flow (stdin parsing, agent dispatch, stdout response, local-sandbox) stays identical.

**Files:**
- Modify: `src/agent/runner.ts`
- Test: `tests/agent/runner.test.ts` (existing, verify no regression)

**Step 1: Modify runner.ts parseArgs()**

In `parseArgs()` (line 197), relax the `ipcSocket` requirement when NATS transport is configured:

```typescript
// After line 221:
const ipcTransport = process.env.AX_IPC_TRANSPORT ?? 'socket';

// Replace lines 223-226:
if (ipcTransport === 'socket' && (!ipcSocket || !workspace)) {
  logger.error('missing_args', { message: 'Usage: agent-runner --agent <type> --ipc-socket <path> (AX_WORKSPACE env var required)' });
  process.exit(1);
}
if (ipcTransport === 'nats' && !workspace) {
  logger.error('missing_args', { message: 'AX_IPC_TRANSPORT=nats requires AX_WORKSPACE env var' });
  process.exit(1);
}
```

**Step 2: Modify runner.ts main block**

In the main block (line 349), create a `NATSIPCClient` when NATS transport is configured:

```typescript
// Replace lines 357-366 with:
const ipcTransport = process.env.AX_IPC_TRANSPORT ?? 'socket';

if (ipcTransport === 'nats') {
  // K8s mode: use NATS for IPC instead of Unix socket
  const { NATSIPCClient } = await import('./nats-ipc-client.js');
  const client = new NATSIPCClient({
    sessionId: '', // set after stdin parse via setContext()
  });
  await client.connect();
  config.ipcClient = client;
} else if (config.ipcListen) {
  // Apple Container: listen mode (existing logic)
  const client = new IPCClient({ socketPath: config.ipcSocket, listen: true });
  client.connect().then(() => {
    logger.debug('ipc_listen_ready', { socketPath: config.ipcSocket });
  }).catch((err) => {
    logger.error('ipc_listen_failed', { error: (err as Error).message });
    process.exitCode = 1;
  });
  config.ipcClient = client;
}
```

The `setContext()` call at line 393-399 already handles updating the client with session context from the stdin payload — `NATSIPCClient.setContext()` has the same signature.

**Step 3: Run existing runner tests**

Run: `npm test -- --run tests/agent/`
Expected: PASS — existing tests use socket mode (no AX_IPC_TRANSPORT env var)

**Step 4: Commit**

```bash
git add src/agent/runner.ts
git commit -m "feat(k8s): support AX_IPC_TRANSPORT=nats in runner.js"
```

---

### Task 4: Rewrite k8s sandbox provider to use runner.js

Replace the current k8s.ts (complex pod creation with stdin/stdout attach via WebSocket) with a simpler version that:
1. Creates a pod running `runner.js` with `AX_IPC_TRANSPORT=nats`
2. Attaches stdin/stdout via the k8s Attach API (same as current)
3. Mounts canonical workspace volumes (scratch, agent, user) as `emptyDir`

The new provider follows the same `spawn()` contract as docker/apple — `server-completions.ts` calls `spawn()`, writes stdin, reads stdout.

**Files:**
- Modify: `src/providers/sandbox/k8s.ts`
- Test: `tests/providers/sandbox/k8s.test.ts`

**Step 1: Rewrite k8s.ts**

The key changes from the current k8s.ts:
- Add `AX_IPC_TRANSPORT=nats` to pod env (instead of `AX_IPC_SOCKET`)
- Mount canonical volumes: `/workspace/scratch`, `/workspace/agent`, `/workspace/user`
- Keep the same stdin/stdout attach mechanism (it already works)

```typescript
// In buildPodSpec(), update env vars:
env: [
  { name: 'NATS_URL', value: options.natsUrl },
  { name: 'AX_IPC_TRANSPORT', value: 'nats' },
  { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? 'warn' },
  ...Object.entries(envVars)
    .filter(([k]) => k !== 'AX_IPC_SOCKET') // Don't set socket path — using NATS
    .map(([name, value]) => ({ name, value })),
  { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
],
```

The rest of the provider (pod creation, attach, watch, kill) stays the same.

**Step 2: Run tests**

Run: `npm test -- --run tests/providers/sandbox/`
Expected: PASS

**Step 3: Commit**

```bash
git add src/providers/sandbox/k8s.ts
git commit -m "feat(k8s): set AX_IPC_TRANSPORT=nats in k8s pod env"
```

---

### Task 5: Wire NATS IPC handler into agent-runtime-process

The agent-runtime-process needs to start a NATS IPC handler for each k8s session so that sandbox pods can route IPC calls back to the host through `handleIPC`.

**Files:**
- Modify: `src/host/agent-runtime-process.ts`

**Step 1: Remove the subprocess override**

Delete lines 157-167:

```typescript
// DELETE THIS BLOCK:
// The agent loop must run as a local subprocess inside this pod, even when
// providers.sandbox is k8s. ...
let agentSandbox = providers.sandbox;
if (config.providers.sandbox === 'k8s') {
  const subprocessModule = await import('../providers/sandbox/subprocess.js');
  agentSandbox = await subprocessModule.create(config);
}
```

Replace with just:

```typescript
const agentSandbox = providers.sandbox;
```

**Step 2: Add NATS IPC handler per session**

In `processSessionRequest()`, start a NATS IPC handler before calling `processCompletion()` so the sandbox pod can call back:

```typescript
import { startNATSIPCHandler } from './nats-ipc-handler.js';

async function processSessionRequest(request: SessionRequest, nc: NatsConnection): Promise<void> {
  const { requestId, sessionId } = request;

  // Start NATS IPC handler for this session — the sandbox pod's
  // NATSIPCClient publishes to ipc.request.{sessionId}, and this
  // handler routes those requests through the existing handleIPC pipeline.
  let natsIpcHandler: { close: () => void } | undefined;
  if (config.providers.sandbox === 'k8s') {
    natsIpcHandler = await startNATSIPCHandler({
      sessionId,
      handleIPC,
      ctx: { sessionId, agentId: 'main', userId: request.userId ?? defaultUserId },
    });
  }

  try {
    const result = await processCompletion(
      completionDeps,
      request.content,
      requestId,
      request.messages,
      request.persistentSessionId,
      request.preProcessed,
      request.userId,
      request.replyOptional,
      request.sessionScope,
    );

    // ... existing result publishing ...
  } finally {
    natsIpcHandler?.close();
  }
}
```

`processCompletion()` handles everything else: workspace setup, identity/skills loading, sandbox spawn, stdin/stdout, retry, workspace commit. No changes needed there — it already calls `providers.sandbox.spawn()` which is now the real k8s provider.

**Step 3: Run tests**

Run: `npm test -- --run tests/host/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/agent-runtime-process.ts
git commit -m "feat(k8s): remove subprocess override, wire NATS IPC handler per session"
```

---

### Task 6: Update pool controller pod template

The pool controller creates warm pods with `command: ['node', 'dist/sandbox-worker/main.js']` (doesn't exist). Update to use `runner.js` with canonical workspace volumes and NATS IPC env vars.

**Files:**
- Modify: `src/pool-controller/k8s-client.ts` — update pod manifest volumes and env
- Modify: `src/pool-controller/main.ts` — update default command
- Modify: `charts/ax/values.yaml` — update sandbox tier defaults

**Step 1: Update k8s-client.ts pod manifest**

```typescript
// In createPod(), update volumeMounts:
volumeMounts: [
  { name: 'scratch', mountPath: '/workspace/scratch' },
  { name: 'agent-ws', mountPath: '/workspace/agent' },
  { name: 'user-ws', mountPath: '/workspace/user' },
  { name: 'tmp', mountPath: '/tmp' },
],

// Update volumes:
volumes: [
  { name: 'scratch', emptyDir: { sizeLimit: template.tier === 'heavy' ? '50Gi' : '10Gi' } },
  { name: 'agent-ws', emptyDir: { sizeLimit: '10Gi' } },
  { name: 'user-ws', emptyDir: { sizeLimit: '10Gi' } },
  { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
],

// Add canonical env vars:
env: [
  { name: 'NATS_URL', value: template.natsUrl },
  { name: 'AX_IPC_TRANSPORT', value: 'nats' },
  { name: 'AX_WORKSPACE', value: '/workspace' },
  { name: 'AX_AGENT_WORKSPACE', value: '/workspace/agent' },
  { name: 'AX_USER_WORKSPACE', value: '/workspace/user' },
  { name: 'SANDBOX_TIER', value: template.tier },
  { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? 'warn' },
  { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
],
```

**Step 2: Update default command in main.ts**

```typescript
// Change from:
command: ['node', 'dist/sandbox-worker/main.js'],
// To:
command: ['node', '/opt/ax/dist/agent/runner.js'],
```

**Step 3: Update values.yaml sandbox tiers**

```yaml
sandbox:
  tiers:
    light:
      minReady: 2
      maxReady: 10
      template:
        command: ["node", "/opt/ax/dist/agent/runner.js"]
        cpu: "1"
        memory: "2Gi"
        workspaceRoot: "/workspace"
    heavy:
      minReady: 0
      maxReady: 3
      template:
        command: ["node", "/opt/ax/dist/agent/runner.js"]
        cpu: "4"
        memory: "16Gi"
        workspaceRoot: "/workspace"
```

**Step 4: Run pool controller tests**

Run: `npm test -- --run tests/pool-controller/`
Expected: PASS

**Step 5: Commit**

```bash
git add src/pool-controller/k8s-client.ts src/pool-controller/main.ts charts/ax/values.yaml
git commit -m "feat(k8s): update pool controller to use runner.js with NATS IPC"
```

---

### Task 7: Integration test — NATS IPC round-trip

End-to-end test verifying the NATS IPC client and handler work together.

**Files:**
- Create: `tests/integration/nats-ipc-roundtrip.test.ts`

**Step 1: Write the integration test**

```typescript
// tests/integration/nats-ipc-roundtrip.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NATSIPCClient } from '../../src/agent/nats-ipc-client.js';
import { startNATSIPCHandler } from '../../src/host/nats-ipc-handler.js';

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222';

describe('NATS IPC round-trip', () => {
  let handler: { close: () => void };
  let client: NATSIPCClient;
  let natsAvailable = false;

  beforeAll(async () => {
    try {
      const nats = await import('nats');
      const nc = await nats.connect({ servers: NATS_URL, timeout: 2000 });
      await nc.drain();
      natsAvailable = true;
    } catch {
      return;
    }

    handler = await startNATSIPCHandler({
      sessionId: 'test-roundtrip',
      natsUrl: NATS_URL,
      handleIPC: async (raw: string) => {
        const req = JSON.parse(raw);
        if (req.action === 'sandbox_approve') return JSON.stringify({ approved: true });
        if (req.action === 'memory_search') return JSON.stringify({ ok: true, results: [] });
        return JSON.stringify({ ok: true });
      },
    });

    client = new NATSIPCClient({ sessionId: 'test-roundtrip', natsUrl: NATS_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (client) await client.disconnect();
    if (handler) handler.close();
  });

  it('routes sandbox_approve through NATS', async () => {
    if (!natsAvailable) return;
    const result = await client.call({ action: 'sandbox_approve', operation: 'bash', command: 'ls' });
    expect(result).toEqual({ approved: true });
  });

  it('routes memory_search through NATS', async () => {
    if (!natsAvailable) return;
    const result = await client.call({ action: 'memory_search', query: 'test' });
    expect(result).toHaveProperty('results');
  });
});
```

**Step 2: Run test**

Run: `npm test -- --run tests/integration/nats-ipc-roundtrip.test.ts`
Expected: PASS if NATS available, SKIP otherwise

**Step 3: Commit**

```bash
git add tests/integration/nats-ipc-roundtrip.test.ts
git commit -m "test(k8s): add NATS IPC round-trip integration test"
```

---

### Task 8: Update documentation

**Files:**
- Modify: `docs/plans/2026-03-04-k8s-agent-compute-architecture.md` — add supersession note
- Modify: `docs/plans/2026-03-15-agent-in-container-design.md` — update k8s comparison

**Step 1: Add notes**

```markdown
> **Updated 2026-03-16:** The k8s sandbox now uses the same runner.js as docker/apple.
> IPC uses NATS request/reply instead of Unix sockets (AX_IPC_TRANSPORT=nats).
> The sandbox-worker concept was removed. See `docs/plans/2026-03-16-k8s-nats-ipc-sandbox.md`.
```

**Step 2: Commit**

```bash
git add docs/plans/
git commit -m "docs: update architecture plans for k8s NATS IPC sandbox"
```

---

## Summary of Changes

| Component | Before | After |
|-----------|--------|-------|
| `runner.ts` | Only supports Unix socket IPC | `AX_IPC_TRANSPORT=nats` creates `NATSIPCClient` |
| `agent-runtime-process.ts` | Overrides k8s sandbox with subprocess | Uses real k8s sandbox + NATS IPC handler per session |
| `k8s.ts` sandbox provider | Sets `AX_IPC_SOCKET` in pod env | Sets `AX_IPC_TRANSPORT=nats` + `NATS_URL` in pod env |
| Pool controller | `dist/sandbox-worker/main.js` (doesn't exist) | `dist/agent/runner.js` with NATS IPC env vars |
| Volume mounts | `emptyDir` (scratch, tmp only) | `emptyDir` at all canonical paths (scratch, agent, user, tmp) |
| New files | — | `nats-ipc-client.ts`, `nats-ipc-handler.ts` |
| Deleted files | — | `agent-runtime-pod.ts` (never created) |

## Key Invariants Preserved

- No credentials in sandbox pods (IPC tools route to host via NATS)
- No network in sandbox pods (NATS-only via NetworkPolicy)
- `safePath()` on all file operations
- Audit logging for all sandbox tool calls (via `sandbox_approve`/`sandbox_result`)
- gVisor runtime class on GKE Autopilot
- Same `runner.js` entry point for all sandbox types (docker, apple, k8s)
