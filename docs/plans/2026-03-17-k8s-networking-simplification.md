# K8s Networking Simplification: NATS Queue Groups + HTTP Gateway

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Consolidate k8s agent↔host networking from 5+ transport mechanisms into two clean layers — NATS for work dispatch/eventing, HTTP for all data exchange — while replacing thundering-herd warm pool claiming with NATS queue groups.

**Architecture:** Agent pods keep NATS only for the initial "give me work" handshake via queue groups (replacing k8s API label-patch claiming). All subsequent communication (IPC commands, LLM proxy, workspace uploads) goes over HTTP to the host's existing server. Docker/apple/subprocess sandboxes are completely untouched — they continue using Unix sockets.

**Tech Stack:** Node.js raw `http` module, NATS queue groups (nats.ws package), native `fetch()`, Zod strict validation, existing `createIPCHandler()` pipeline.

---

## Scope: K8s Only — Docker/Apple Unchanged

These changes are **scoped exclusively to k8s transport** (`AX_IPC_TRANSPORT=http`). The transport selection in `src/agent/runner.ts:464` branches on `AX_IPC_TRANSPORT`:

| Transport | Sandbox modes | IPC | LLM Proxy | Changed? |
|-----------|--------------|-----|-----------|----------|
| `socket` (default) | subprocess, docker, apple | Unix socket `IPCClient` | `tcp-bridge.ts` → `proxy.ts` | **No** |
| `http` (new) | k8s | `HttpIPCClient` → host HTTP | Direct HTTP to `/internal/llm-proxy` | **New** |
| `nats` (deprecated) | k8s (legacy) | `NATSIPCClient` | `nats-bridge.ts` → `nats-llm-proxy.ts` | **Removed in Phase 4** |

**Files untouched (docker/apple depend on these):**
- `src/agent/ipc-client.ts` — Unix socket IPC client
- `src/agent/tcp-bridge.ts` — localhost TCP → Unix socket LLM proxy
- `src/agent/web-proxy-bridge.ts` — localhost TCP → Unix socket web proxy
- `src/host/ipc-server.ts` — Unix socket IPC server + `createIPCHandler()` pipeline
- `src/host/proxy.ts` — Unix socket credential proxy (refactored internally, same interface)

## Before and After (K8s Only)

```
BEFORE (5+ mechanisms):                    AFTER (2 layers):

Agent ──NATS──→ IPC handler               Agent ──NATS──→ Queue group work dispatch
Agent ──NATS──→ LLM proxy (via bridge)     Agent ──HTTP──→ /internal/ipc
Agent ──HTTP──→ Web proxy :3128            Agent ──HTTP──→ /internal/llm-proxy/v1/*
Agent ──HTTP──→ Workspace staging          Agent ──HTTP──→ /internal/workspace/release
Agent ──NATS──→ Workspace release key      Agent ──HTTP──→ CONNECT (web proxy, merged)
Host  ──k8s API──→ Label patch claiming    Host  ──NATS──→ sandbox.work (queue group)
```

---

## Task 1: NATS Queue Group Work Subscription (Agent Side)

Replace per-pod NATS subject (`agent.work.{podName}`) with queue group subscription. Warm pods subscribe to `sandbox.work` with queue group `{tier}`. NATS delivers work to exactly one subscriber — no k8s API claiming needed.

**Files:**
- Modify: `src/agent/runner.ts:426-451` (`waitForNATSWork()`)
- Test: `tests/agent/queue-group-work.test.ts` (new)

**Step 1: Write the failing test**

Create `tests/agent/queue-group-work.test.ts` that verifies:
- Warm pod subscribes to `sandbox.work` with queue group from `SANDBOX_TIER` env
- Pod replies with `{ podName }` when work arrives
- Work payload is returned for processing

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('waitForNATSWork queue group', () => {
  it('subscribes to sandbox.work with tier-based queue group', async () => {
    // Mock NATS connection and subscription
    // Set SANDBOX_TIER=light
    // Verify subscribe('sandbox.work', { max: 1, queue: 'light' })
    // Verify reply with { podName } on message receipt
  });

  it('defaults to light tier when SANDBOX_TIER not set', async () => {
    // Verify queue group defaults to 'light'
  });

  it('returns decoded work payload', async () => {
    // Publish mock work message
    // Verify returned string matches payload
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/queue-group-work.test.ts`
Expected: FAIL (function not updated yet)

**Step 3: Modify `waitForNATSWork()` in `src/agent/runner.ts`**

```typescript
// src/agent/runner.ts — waitForNATSWork() at line 426
async function waitForNATSWork(): Promise<string> {
  const podName = process.env.POD_NAME ?? 'unknown';
  const tier = process.env.SANDBOX_TIER ?? 'light';

  const natsModule = await import('nats');
  const { natsConnectOptions } = await import('../utils/nats.js');
  const nc = await natsModule.connect(natsConnectOptions('runner', podName));

  // Queue group subscription: NATS delivers to exactly one subscriber per tier
  const sub = nc.subscribe('sandbox.work', { max: 1, queue: tier });
  logger.info('nats_work_waiting', { subject: 'sandbox.work', queue: tier, podName });
  process.stderr.write(`[diag] waiting for work on sandbox.work (queue: ${tier})\n`);

  for await (const msg of sub) {
    const data = new TextDecoder().decode(msg.data);
    logger.info('nats_work_received', { queue: tier, bytes: data.length });
    process.stderr.write(`[diag] work received: ${data.length} bytes\n`);

    // Reply with podName so host can track which pod is processing
    if (msg.reply) {
      msg.respond(new TextEncoder().encode(JSON.stringify({ podName })));
    }

    await nc.drain();
    return data;
  }

  await nc.drain();
  throw new Error('NATS work subscription ended without receiving a message');
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/agent/queue-group-work.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/runner.ts tests/agent/queue-group-work.test.ts
git commit -m "feat(agent): switch work dispatch to NATS queue groups"
```

---

## Task 2: Queue Group Work Publishing (Host Side)

Change host from publishing to `agent.work.{podName}` to using NATS `request()` on `sandbox.work`. The reply contains the claiming pod's name (needed for exit watching).

**Files:**
- Modify: `src/host/host-process.ts:476-481` (`publishWork` lambda)
- Modify: `src/providers/sandbox/k8s.ts:344-397` (spawn flow)
- Test: `tests/providers/sandbox/k8s-warm-pool.test.ts` (modify)

**Step 1: Write/update the failing test**

Update `tests/providers/sandbox/k8s-warm-pool.test.ts`:
- Test that `publishWork` uses `nc.request('sandbox.work', ...)` with 5s timeout
- Test that on timeout (no warm pod), host falls back to cold start with per-pod subject
- Test that reply `{ podName }` is used for exit watching

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/providers/sandbox/k8s-warm-pool.test.ts`
Expected: FAIL

**Step 3: Modify `publishWork` in `src/host/host-process.ts`**

```typescript
// src/host/host-process.ts — replace publishWork at line 476
const publishWork = isK8s
  ? async (payload: string): Promise<string> => {
      // Try queue group first (warm pods)
      try {
        const reply = await nc.request(
          'sandbox.work',
          new TextEncoder().encode(payload),
          { timeout: 5000 },
        );
        const { podName } = JSON.parse(new TextDecoder().decode(reply.data));
        logger.info('nats_work_claimed', { podName, payloadBytes: payload.length });
        return podName;
      } catch (err) {
        // Timeout = no warm pods available, caller should cold start
        logger.info('nats_work_queue_timeout', { error: (err as Error).message });
        throw err;
      }
    }
  : undefined;
```

**Step 4: Modify spawn flow in `src/providers/sandbox/k8s.ts`**

- Remove `warmPoolClient` import and initialization
- Remove `spawnWarm()` function (claiming now happens via NATS queue group)
- `spawn()` now: try `publishWork()` → if warm pod replies, watch that pod; if timeout, `spawnCold()` + publish to per-pod subject as fallback

**Step 5: Run tests to verify they pass**

Run: `npm test -- --run tests/providers/sandbox/k8s-warm-pool.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/host/host-process.ts src/providers/sandbox/k8s.ts tests/providers/sandbox/k8s-warm-pool.test.ts
git commit -m "feat(host): publish work via NATS queue groups, remove label-based claiming"
```

---

## Task 3: Simplify Pool Controller + Delete Warm Pool Client

Remove `claimed` status from pool controller reconciliation. Delete `warm-pool-client.ts`.

**Files:**
- Modify: `src/pool-controller/controller.ts` (remove claimed status tracking)
- Modify: `src/pool-controller/k8s-client.ts` (simplify pod status type)
- Delete: `src/providers/sandbox/warm-pool-client.ts` (144 lines)
- Delete: `tests/providers/sandbox/warm-pool-client.test.ts`
- Modify: `tests/pool-controller/controller.test.ts`

**Step 1: Update pool controller tests**

Modify `tests/pool-controller/controller.test.ts`:
- Remove tests for `claimed` pod status
- Verify reconciliation only counts `warm` (Running) and `warm` (Pending)
- Verify GC still cleans terminal pods

**Step 2: Run tests to verify they fail**

Run: `npm test -- --run tests/pool-controller/controller.test.ts`
Expected: FAIL (tests reference removed status)

**Step 3: Simplify pool controller**

In `src/pool-controller/controller.ts`:
- Remove filtering/counting of `claimed` pods
- Reconciliation counts: `warmRunning` (status=warm, phase=Running), `warmPending` (status=warm, phase=Pending), `terminal` (Succeeded/Failed)

In `src/pool-controller/k8s-client.ts`:
- Remove `'claimed'` from `PodPoolStatus` type if it exists
- Pods only have `ax.io/status=warm` label (for observability, not claiming)

**Step 4: Delete warm-pool-client**

```bash
rm src/providers/sandbox/warm-pool-client.ts
rm tests/providers/sandbox/warm-pool-client.test.ts
```

Remove import from `src/providers/sandbox/k8s.ts`.

**Step 5: Run full test suite**

Run: `npm test -- --run`
Expected: PASS (no remaining references to deleted files)

**Step 6: Commit**

```bash
git add -A
git commit -m "refactor(pool): remove claimed status and warm-pool-client, simplify reconciliation"
```

---

## Task 4: Create HttpIPCClient

Drop-in replacement for `NATSIPCClient`. Implements the same `IIPCClient` interface (`src/agent/runner.ts:38`). Uses `fetch()` POST to `http://ax-host.{namespace}.svc:8080/internal/ipc` instead of NATS request/reply.

**Files:**
- Create: `src/agent/http-ipc-client.ts` (~90 lines)
- Test: `tests/agent/http-ipc-client.test.ts` (new)

**Step 1: Write the failing test**

Create `tests/agent/http-ipc-client.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpIPCClient } from '../../../src/agent/http-ipc-client.js';

describe('HttpIPCClient', () => {
  let server: any; // http.Server for mock host

  beforeEach(() => { /* start mock HTTP server */ });
  afterEach(() => { /* close server */ });

  it('sends IPC call as POST to /internal/ipc', async () => {
    // Mock server returns { result: 'ok' }
    const client = new HttpIPCClient({ hostUrl: `http://localhost:${port}` });
    client.setContext({ token: 'test-token', sessionId: 'sess-1' });
    const result = await client.call({ action: 'memory_read', key: 'foo' });
    expect(result).toEqual({ result: 'ok' });
    // Verify request had Authorization: Bearer test-token
    // Verify body included _sessionId: 'sess-1'
  });

  it('enriches request with session metadata', async () => {
    const client = new HttpIPCClient({ hostUrl: `http://localhost:${port}` });
    client.setContext({ sessionId: 's1', requestId: 'r1', userId: 'u1', sessionScope: 'dm', token: 't1' });
    await client.call({ action: 'web_fetch', url: 'https://example.com' });
    // Verify body has _sessionId, _requestId, _userId, _sessionScope
  });

  it('throws on timeout', async () => {
    // Mock server delays 5s, client timeout 100ms
    const client = new HttpIPCClient({ hostUrl: `http://localhost:${port}`, timeoutMs: 100 });
    client.setContext({ token: 'tok' });
    await expect(client.call({ action: 'llm_call' })).rejects.toThrow();
  });

  it('connect() and disconnect() are no-ops', async () => {
    const client = new HttpIPCClient({ hostUrl: 'http://localhost:1' });
    await client.connect(); // no-op, no throw
    client.disconnect();    // no-op, no throw
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/http-ipc-client.test.ts`
Expected: FAIL (module doesn't exist)

**Step 3: Create `src/agent/http-ipc-client.ts`**

```typescript
// src/agent/http-ipc-client.ts — HTTP-based IPC client for k8s sandbox pods.
//
// Drop-in replacement for NATSIPCClient when running inside a k8s pod with
// AX_IPC_TRANSPORT=http. Uses fetch() POST to host HTTP server instead of
// NATS request/reply. Selected by runner.ts based on env var.

import { getLogger } from '../logger.js';
import type { IIPCClient } from './runner.js';

const logger = getLogger().child({ component: 'http-ipc-client' });

const DEFAULT_TIMEOUT_MS = 30_000;

export interface HttpIPCClientOptions {
  hostUrl: string;
  timeoutMs?: number;
}

export class HttpIPCClient implements IIPCClient {
  private hostUrl: string;
  private timeoutMs: number;
  private sessionId = '';
  private requestId?: string;
  private userId?: string;
  private sessionScope?: string;
  private token?: string;

  constructor(opts: HttpIPCClientOptions) {
    this.hostUrl = opts.hostUrl;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.token = process.env.AX_IPC_TOKEN;
  }

  setContext(ctx: {
    sessionId?: string;
    requestId?: string;
    userId?: string;
    sessionScope?: string;
    token?: string;
  }): void {
    if (ctx.sessionId !== undefined) this.sessionId = ctx.sessionId;
    if (ctx.requestId !== undefined) this.requestId = ctx.requestId;
    if (ctx.userId !== undefined) this.userId = ctx.userId;
    if (ctx.sessionScope !== undefined) this.sessionScope = ctx.sessionScope;
    if (ctx.token !== undefined) this.token = ctx.token;
  }

  async connect(): Promise<void> {
    // No-op — HTTP is connectionless
    logger.info('http_ipc_ready', { hostUrl: this.hostUrl });
  }

  disconnect(): void {
    // No-op
  }

  async call(
    request: Record<string, unknown>,
    callTimeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const enriched = {
      ...request,
      _sessionId: this.sessionId,
      ...(this.requestId ? { _requestId: this.requestId } : {}),
      ...(this.userId ? { _userId: this.userId } : {}),
      ...(this.sessionScope ? { _sessionScope: this.sessionScope } : {}),
    };

    const effectiveTimeout = callTimeoutMs ?? this.timeoutMs;

    logger.debug('call_start', {
      action: request.action,
      hostUrl: this.hostUrl,
      timeoutMs: effectiveTimeout,
    });

    const res = await fetch(`${this.hostUrl}/internal/ipc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`,
      },
      body: JSON.stringify(enriched),
      signal: AbortSignal.timeout(effectiveTimeout),
    });

    const result = await res.json() as Record<string, unknown>;
    logger.debug('call_done', { action: request.action });
    return result;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --run tests/agent/http-ipc-client.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/http-ipc-client.ts tests/agent/http-ipc-client.test.ts
git commit -m "feat(agent): add HttpIPCClient for k8s HTTP transport"
```

---

## Task 5: Add `/internal/ipc` Route to Host

Add HTTP endpoint that validates per-turn token and routes through existing `handleIPC` pipeline. Add token registry (`activeTokens` map).

**Files:**
- Modify: `src/host/host-process.ts` (add route + token registry)
- Test: `tests/host/internal-ipc-route.test.ts` (new)

**Step 1: Write the failing test**

Create `tests/host/internal-ipc-route.test.ts`:

```typescript
describe('/internal/ipc route', () => {
  it('returns 401 for missing/invalid token', async () => {
    // POST /internal/ipc without Authorization header → 401
  });

  it('dispatches to handleIPC with bound context', async () => {
    // Register token in activeTokens
    // POST /internal/ipc with valid token + IPC payload
    // Verify handleIPC called with correct ctx (host-bound sessionId, not agent-supplied)
  });

  it('returns JSON response from handler', async () => {
    // Mock handleIPC returns '{"memories":[]}'
    // Verify HTTP response is 200 with correct JSON
  });

  it('cleans up token on turn completion', async () => {
    // Register token, then delete it
    // Verify subsequent request returns 401
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/internal-ipc-route.test.ts`
Expected: FAIL

**Step 3: Add token registry and route to `src/host/host-process.ts`**

Add `activeTokens` map at module scope:

```typescript
// Token registry: maps per-turn tokens to their bound IPC handler + context.
// Registered before sandbox spawn, deleted in finally block.
const activeTokens = new Map<string, {
  handleIPC: (raw: string, ctx: IPCContext) => Promise<string>;
  ctx: IPCContext;
}>();
```

Add route in `handleRequest()` (after existing `/internal/workspace-staging`):

```typescript
if (url === '/internal/ipc' && req.method === 'POST') {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const entry = token ? activeTokens.get(token) : undefined;
  if (!entry) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid token' }));
    return;
  }
  const body = await readBody(req, 1_048_576); // 1MB max
  const result = await entry.handleIPC(body.toString(), entry.ctx);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(result);
  return;
}
```

In `processCompletionWithNATS()`, register token before sandbox spawn:

```typescript
activeTokens.set(turnToken, { handleIPC: wrappedHandleIPC, ctx: { sessionId, agentId: 'main', userId: userId ?? defaultUserId } });
```

In the `finally` block:

```typescript
activeTokens.delete(turnToken);
```

**Step 4: Run tests**

Run: `npm test -- --run tests/host/internal-ipc-route.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/host-process.ts tests/host/internal-ipc-route.test.ts
git commit -m "feat(host): add /internal/ipc HTTP route with token registry"
```

---

## Task 6: Switch Agent Runner to HttpIPCClient

Wire up the new `http` transport in `runner.ts` and update sandbox env vars.

**Files:**
- Modify: `src/agent/runner.ts:464-485` (add `http` transport branch)
- Modify: `src/host/host-process.ts:487-494` (change `AX_IPC_TRANSPORT` to `http`)
- Modify: `src/pool-controller/k8s-client.ts` (update warm pod env vars)

**Step 1: Add `http` transport branch to `src/agent/runner.ts`**

```typescript
if (ipcTransport === 'http') {
  const { HttpIPCClient } = await import('./http-ipc-client.js');
  const client = new HttpIPCClient({
    hostUrl: process.env.AX_HOST_URL!,
  });
  await client.connect();
  config.ipcClient = client;

  waitForNATSWork().then((data) => {
    const payload = parseStdinPayload(data);
    applyPayload(config, payload);
    return run(config);
  }).catch((err) => {
    logger.error('main_error', { error: (err as Error).message, stack: (err as Error).stack });
    process.exitCode = 1;
    process.stderr.write(`Agent runner error: ${(err as Error).message ?? err}\n`);
  });
} else if (ipcTransport === 'nats') {
  // Legacy: keep for migration period
  // ... existing NATS code ...
} else {
  // ... existing socket code ...
}
```

**Step 2: Update env vars in `src/host/host-process.ts`**

In `extraSandboxEnv` (line 487):

```typescript
AX_IPC_TRANSPORT: 'http',  // was implied 'nats'
```

**Step 3: Update env vars in `src/pool-controller/k8s-client.ts`**

Add `AX_HOST_URL` and change `AX_IPC_TRANSPORT` to `http` in warm pod template.

**Step 4: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/runner.ts src/host/host-process.ts src/pool-controller/k8s-client.ts
git commit -m "feat(agent): wire HttpIPCClient as default k8s transport"
```

---

## Task 7: Extract Credential Injection + Add `/internal/llm-proxy` Route

Extract shared credential injection from `proxy.ts` into `llm-proxy-core.ts`. Add HTTP route for LLM proxy with native SSE streaming.

**Files:**
- Create: `src/host/llm-proxy-core.ts` (~120 lines)
- Modify: `src/host/host-process.ts` (add `/internal/llm-proxy` route)
- Modify: `src/host/proxy.ts` (call `llm-proxy-core.ts`)
- Test: `tests/host/llm-proxy-route.test.ts` (new)

**Step 1: Write the failing test**

Create `tests/host/llm-proxy-route.test.ts`:
- Test token validation via `x-api-key` header
- Test credential injection (dummy key replaced with real ANTHROPIC_API_KEY)
- Test SSE streaming response passes through
- Test 401 on invalid token

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/host/llm-proxy-route.test.ts`
Expected: FAIL

**Step 3: Create `src/host/llm-proxy-core.ts`**

Extract from `src/host/proxy.ts`:
- `forwardLLMRequest()` — credential injection, request forwarding, streaming response
- `injectCredentials()` — API key or OAuth token injection, Claude Code identity headers
- `handleAuthRefresh()` — reactive 401 retry with `refreshCredentials()`

Both `proxy.ts` (Unix socket, local) and the HTTP route (k8s) call these functions.

**Step 4: Add `/internal/llm-proxy` route to `src/host/host-process.ts`**

```typescript
if (url.startsWith('/internal/llm-proxy/') && req.method === 'POST') {
  const token = req.headers['x-api-key'] as string;
  const entry = token ? activeTokens.get(token) : undefined;
  if (!entry) { res.writeHead(401); res.end(); return; }
  const targetPath = url.replace('/internal/llm-proxy', '');
  const body = await readBody(req, 10_485_760);
  await forwardLLMRequest({ targetPath, body, incomingHeaders: req.headers, res });
  return;
}
```

**Step 5: Refactor `src/host/proxy.ts` to use `llm-proxy-core.ts`**

Replace inline credential injection with calls to extracted functions. Same behavior, less duplication.

**Step 6: Run tests**

Run: `npm test -- --run tests/host/llm-proxy-route.test.ts && npm test -- --run`
Expected: PASS (new tests + all existing proxy tests still pass)

**Step 7: Commit**

```bash
git add src/host/llm-proxy-core.ts src/host/host-process.ts src/host/proxy.ts tests/host/llm-proxy-route.test.ts
git commit -m "feat(host): add /internal/llm-proxy HTTP route with shared credential injection"
```

---

## Task 8: Agent Direct HTTP for LLM (No Bridge)

Claude-code agents in k8s hit the host's LLM proxy route directly. No `nats-bridge.ts`, no `tcp-bridge.ts` for k8s mode. The per-turn token is sent as `ANTHROPIC_API_KEY`.

**Files:**
- Modify: `src/agent/runners/claude-code.ts` (add `http` transport branch)

**Step 1: Modify claude-code runner**

In `src/agent/runners/claude-code.ts`, add `http` transport check before existing bridge logic:

```typescript
const isHTTPTransport = process.env.AX_IPC_TRANSPORT === 'http';
if (isHTTPTransport) {
  // K8s HTTP mode: agent hits host LLM proxy directly, no bridge needed
  env.ANTHROPIC_BASE_URL = `${process.env.AX_HOST_URL}/internal/llm-proxy`;
  env.ANTHROPIC_API_KEY = process.env.AX_IPC_TOKEN; // per-turn token as auth
} else if (useNATSBridge) {
  // ... existing NATS bridge code (legacy, kept during migration) ...
} else {
  // ... existing TCP bridge code (docker/apple) ...
}
```

**Step 2: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/agent/runners/claude-code.ts
git commit -m "feat(runners): claude-code uses direct HTTP LLM proxy in k8s mode"
```

---

## Task 9: Simplify Workspace Release to Single HTTP POST

Replace the two-step staging upload + NATS IPC dance with a single HTTP POST.

**Files:**
- Modify: `src/agent/workspace-release.ts` (single POST, no staging key)
- Modify: `src/host/host-process.ts` (add `/internal/workspace/release` route, remove staging store)
- Modify: `tests/agent/workspace-release.test.ts`

**Step 1: Update workspace release test**

Modify `tests/agent/workspace-release.test.ts`:
- Test workspace-cli.ts posts directly to `/internal/workspace/release` with auth token
- No staging key round-trip
- Verify single HTTP call

**Step 2: Run test to verify it fails**

Run: `npm test -- --run tests/agent/workspace-release.test.ts`
Expected: FAIL

**Step 3: Add `/internal/workspace/release` route to host**

```typescript
if (url === '/internal/workspace/release' && req.method === 'POST') {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const entry = token ? activeTokens.get(token) : undefined;
  if (!entry) { res.writeHead(401); res.end('invalid token'); return; }

  const compressed = await readBody(req, 52_428_800); // 50MB
  const json = gunzipSync(compressed).toString('utf-8');
  const payload = JSON.parse(json);
  const changes = (payload.changes ?? []).map((c: any) => ({
    scope: c.scope,
    path: c.path,
    type: c.type,
    content: c.content_base64 ? Buffer.from(c.content_base64, 'base64') : undefined,
    size: c.size,
  }));

  if (providers.workspace?.setRemoteChanges) {
    providers.workspace.setRemoteChanges(entry.ctx.sessionId, changes);
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, changeCount: changes.length }));
  return;
}
```

**Step 4: Simplify `src/agent/workspace-release.ts`**

Pass `--token` to workspace-cli.ts so it includes `Authorization` header. Remove the IPC call for `workspace_release`.

**Step 5: Remove staging store from host-process.ts**

Delete `stagingStore`, `handleWorkspaceStaging()`, `cleanupStaging()`, `STAGING_TTL_MS`, `MAX_STAGING_BYTES`.

**Step 6: Run tests**

Run: `npm test -- --run`
Expected: PASS

**Step 7: Commit**

```bash
git add src/agent/workspace-release.ts src/host/host-process.ts tests/agent/workspace-release.test.ts
git commit -m "feat(workspace): single HTTP POST for workspace release, remove staging store"
```

---

## Task 10: Remove NATS IPC Handler from Host

Remove per-turn NATS IPC handler setup now that HTTP handles all IPC.

**Files:**
- Modify: `src/host/host-process.ts` (remove `startNATSIPCHandler` + `startNATSLLMProxy` calls)

**Step 1: Remove NATS handler setup**

In `processCompletionWithNATS()`:
- Remove `startNATSIPCHandler()` call (lines 456-462)
- Remove `startNATSLLMProxy()` call (lines 467-470)
- Remove `natsIpcHandler.close()` from finally (lines 523-525)
- Remove `llmProxy.close()` from finally (lines 519-521)
- Token registry (`activeTokens.set/delete`) replaces all of this

**Step 2: Run full test suite**

Run: `npm test -- --run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/host/host-process.ts
git commit -m "refactor(host): remove per-turn NATS IPC handler, HTTP routes handle all IPC"
```

---

## Task 11: Delete Dead NATS Transport Files

Remove all files that are no longer used.

**Files:**
- Delete: `src/agent/nats-ipc-client.ts` (107 lines)
- Delete: `src/agent/nats-bridge.ts` (174 lines)
- Delete: `src/host/nats-ipc-handler.ts` (93 lines)
- Delete: `src/host/nats-llm-proxy.ts` (224 lines)
- Delete: `tests/agent/nats-ipc-client.test.ts`
- Delete: `tests/host/nats-ipc-handler.test.ts`
- Delete: `tests/host/nats-llm-proxy.test.ts`

**Step 1: Delete files and remove imports**

```bash
rm src/agent/nats-ipc-client.ts src/agent/nats-bridge.ts
rm src/host/nats-ipc-handler.ts src/host/nats-llm-proxy.ts
rm tests/agent/nats-ipc-client.test.ts tests/host/nats-ipc-handler.test.ts tests/host/nats-llm-proxy.test.ts
```

Remove dead imports from:
- `src/host/host-process.ts` — `startNATSIPCHandler`, `startNATSLLMProxy`
- `src/agent/runners/claude-code.ts` — `startNATSBridge`
- `src/agent/runner.ts` — `NATSIPCClient` (keep `nats` branch during migration or remove if ready)

**Step 2: Build + test**

Run: `npm run build && npm test -- --run`
Expected: No TS errors, all tests PASS

**Step 3: Commit**

```bash
git add -A
git commit -m "refactor: delete NATS IPC transport files (742 lines removed)"
```

---

## Migration Strategy

Support both transports during rollout via `AX_IPC_TRANSPORT` env var:

1. `socket` — Local/docker/apple (unchanged, default)
2. `http` — New k8s (target)
3. `nats` — Legacy k8s (kept in Task 11 if needed, deleted when all pods upgraded)

Host runs HTTP routes alongside NATS handlers during transition. Remove `nats` branch after full rollout.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Queue group message lost if no warm pods subscribed | NATS `request()` with 5s timeout; fall back to cold start |
| HTTP IPC latency vs NATS | K8s Service networking is low-latency; HTTP keep-alive |
| HTTP connection drops mid-LLM-stream | Same risk as NATS; Agent SDK handles retries |
| Token map memory leak if turn crashes | TTL-based cleanup sweep (60s interval) |
| Backward compat during rollout | Both transports run simultaneously; incremental pod upgrade |

---

## Net Effect

- **Removed:** ~742 lines of NATS transport code, staging store, label-based claiming
- **Added:** ~210 lines (HttpIPCClient ~90, llm-proxy-core ~120)
- **Eliminated:** k8s API calls in claiming hot path, base64 encoding, NATS payload chunking, staging key dances, bridge processes in agent pods
- **Preserved:** All security controls (per-turn tokens, credential injection, taint tagging, audit logging, canary scanning)
- **Unchanged:** Docker/apple/subprocess sandboxes (Unix socket transport)
