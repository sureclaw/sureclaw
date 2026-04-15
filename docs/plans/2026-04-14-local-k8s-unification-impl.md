# Local/K8s Unification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge `server-local.ts` and `server-k8s.ts` into a single `server.ts`, generalize session management for both Docker and k8s, make Docker containers session-long with a work loop, and remove Apple Container support.

**Architecture:** Unified server uses a `SessionManager` that tracks sandbox processes (Docker containers or k8s pods) across turns. First turn delivers work via stdin; subsequent turns queue work that the agent polls via a new `fetch_work` IPC action. Response always comes back via `agent_response` IPC (never stdout). Web proxy with credential placeholders is always enabled for container sandboxes.

**Tech Stack:** TypeScript, Node.js, Zod (IPC schemas), vitest (testing), Helm (k8s chart)

**Design doc:** `docs/plans/2026-04-14-local-k8s-unification-design.md`

---

## Task 1: Add `fetch_work` IPC Action Schema

**Files:**
- Modify: `src/ipc-schemas.ts`
- Test: `tests/ipc-schema-validation.test.ts` (or existing schema test)

**Step 1: Write the failing test**

In the IPC schema test file, add:

```typescript
it('validates fetch_work action', () => {
  const valid = { action: 'fetch_work' };
  expect(() => IPC_SCHEMAS['fetch_work'].parse(valid)).not.toThrow();
  expect(VALID_ACTIONS).toContain('fetch_work');
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/ipc-schema`
Expected: FAIL — `fetch_work` not in IPC_SCHEMAS

**Step 3: Add `fetch_work` schema to `src/ipc-schemas.ts`**

After the `agent_response` / `workspace_release` section (~line 430), add:

```typescript
// Agent work loop — agent polls for queued work (multi-turn sessions)
ipcAction('fetch_work', {});
```

No fields needed — the response carries the work payload. The handler returns `{ ok: true, payload: string | null }`.

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/ipc-schema`
Expected: PASS

**Step 5: Commit**

```bash
git add src/ipc-schemas.ts tests/
git commit -m "feat: add fetch_work IPC action schema for multi-turn work loop"
```

---

## Task 2: Build `SessionManager`

Generalize `session-pod-manager.ts` into a transport-agnostic session manager that handles both Docker containers and k8s pods.

**Files:**
- Create: `src/host/session-manager.ts`
- Test: `tests/host/session-manager.test.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionManager, type SessionManager } from '../../src/host/session-manager.js';

describe('SessionManager', () => {
  let manager: SessionManager;
  const onKill = vi.fn();

  beforeEach(() => {
    manager = createSessionManager({
      idleTimeoutMs: 5_000,
      cleanIdleTimeoutMs: 2_000,
      warningLeadMs: 1_000,
      onKill,
    });
  });

  it('registers and retrieves a session', () => {
    const kill = vi.fn();
    manager.register('s1', { pid: 1, kill, podName: 'pod-1' });
    expect(manager.has('s1')).toBe(true);
    expect(manager.get('s1')?.pid).toBe(1);
  });

  it('returns undefined for unknown session', () => {
    expect(manager.get('unknown')).toBeUndefined();
    expect(manager.has('unknown')).toBe(false);
  });

  it('removes a session', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.remove('s1');
    expect(manager.has('s1')).toBe(false);
  });

  it('marks session dirty', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.markDirty('s1');
    expect(manager.get('s1')?.dirty).toBe(true);
  });

  it('queues and claims work', () => {
    manager.register('s1', { pid: 1, kill: vi.fn() });
    manager.queueWork('s1', '{"message":"hello"}');
    const work = manager.claimWork('s1');
    expect(work).toBe('{"message":"hello"}');
    // Second claim returns undefined
    expect(manager.claimWork('s1')).toBeUndefined();
  });

  it('maps auth token to session', () => {
    manager.register('s1', { pid: 1, kill: vi.fn(), authToken: 'tok-1' });
    expect(manager.findSessionByToken('tok-1')).toBe('s1');
  });

  it('shutdown kills all sessions', () => {
    const kill1 = vi.fn();
    const kill2 = vi.fn();
    manager.register('s1', { pid: 1, kill: kill1 });
    manager.register('s2', { pid: 2, kill: kill2 });
    manager.shutdown();
    expect(kill1).toHaveBeenCalled();
    expect(kill2).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm test -- --bail tests/host/session-manager.test.ts`
Expected: FAIL — module not found

**Step 3: Implement `src/host/session-manager.ts`**

Port from `session-pod-manager.ts` with these changes:
- Rename `SessionPod` → `SessionEntry` (not k8s-specific)
- `podName` becomes optional (Docker containers don't have pod names)
- Add `authToken` as optional in `register()` (only k8s needs it)
- Add `queueWork()` / `claimWork()` (moved from session-pod-manager, also used by Docker via socket IPC)
- Keep the same idle timer logic (dirty vs clean timeout, warning + kill)
- Export `SessionManager` type alias for the return type

```typescript
/**
 * Session Manager — Tracks session-long sandboxes across turns.
 *
 * Unified replacement for SessionPodManager. Works with both Docker containers
 * (via Unix socket IPC) and k8s pods (via HTTP IPC). Maps sessionId → active
 * sandbox process. Sandbox processes are reused across turns within a session.
 *
 * Work payloads are queued per-session; agents fetch via fetch_work IPC action
 * or GET /internal/work (k8s HTTP fallback).
 */

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'session-manager' });

export interface SessionEntry {
  pid: number;
  /** Pod name (k8s) or container name (Docker). Optional. */
  podName?: string;
  sessionId: string;
  /** Auth token for HTTP IPC authentication (k8s only). */
  authToken?: string;
  /** Last activity timestamp (ms). Reset on every touch(). */
  lastActivity: number;
  /** Whether the sandbox has made filesystem changes. */
  dirty: boolean;
  /** Timer for the expiry warning. */
  warningTimer?: ReturnType<typeof setTimeout>;
  /** Timer for the final kill. */
  killTimer?: ReturnType<typeof setTimeout>;
  /** Kill function from SandboxProcess. */
  kill: () => void;
}

export interface SessionManagerOptions {
  idleTimeoutMs: number;
  cleanIdleTimeoutMs?: number;
  warningLeadMs: number;
  onExpiring?: (sessionId: string, entry: SessionEntry) => Promise<void>;
  onKill?: (sessionId: string, entry: SessionEntry) => void;
}

export type SessionManager = ReturnType<typeof createSessionManager>;

export function createSessionManager(opts: SessionManagerOptions) {
  const sessions = new Map<string, SessionEntry>();
  const tokenToSession = new Map<string, string>();
  const pendingWork = new Map<string, string>(); // sessionId → payload

  const cleanTimeout = opts.cleanIdleTimeoutMs ?? opts.idleTimeoutMs;

  function teardown(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    if (entry.warningTimer) clearTimeout(entry.warningTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);
    pendingWork.delete(sessionId);
    if (entry.authToken) tokenToSession.delete(entry.authToken);
    sessions.delete(sessionId);
  }

  function resetIdleTimer(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (!entry) return;
    entry.lastActivity = Date.now();
    if (entry.warningTimer) clearTimeout(entry.warningTimer);
    if (entry.killTimer) clearTimeout(entry.killTimer);

    const effectiveTimeout = entry.dirty ? opts.idleTimeoutMs : cleanTimeout;
    const warningDelay = effectiveTimeout - opts.warningLeadMs;

    entry.warningTimer = setTimeout(async () => {
      logger.info('session_expiring_warning', { sessionId, podName: entry.podName });
      try {
        await opts.onExpiring?.(sessionId, entry);
      } catch (err) {
        logger.warn('session_expiring_callback_failed', { sessionId, error: (err as Error).message });
      }
      entry.killTimer = setTimeout(() => {
        logger.info('session_idle_kill', { sessionId, podName: entry.podName, dirty: entry.dirty });
        entry.kill();
        teardown(sessionId);
        opts.onKill?.(sessionId, entry);
      }, opts.warningLeadMs);
      if (entry.killTimer.unref) entry.killTimer.unref();
    }, Math.max(warningDelay, 0));
    if (entry.warningTimer.unref) entry.warningTimer.unref();
  }

  return {
    register(sessionId: string, info: { pid: number; kill: () => void; podName?: string; authToken?: string }): void {
      const entry: SessionEntry = {
        ...info,
        sessionId,
        lastActivity: Date.now(),
        dirty: false,
      };
      sessions.set(sessionId, entry);
      if (info.authToken) tokenToSession.set(info.authToken, sessionId);
      resetIdleTimer(sessionId);
      logger.info('session_registered', { sessionId, podName: info.podName, pid: info.pid });
    },

    get(sessionId: string): SessionEntry | undefined {
      return sessions.get(sessionId);
    },

    has(sessionId: string): boolean {
      return sessions.has(sessionId);
    },

    remove(sessionId: string): void {
      teardown(sessionId);
    },

    touch(sessionId: string): void {
      resetIdleTimer(sessionId);
    },

    markDirty(sessionId: string): void {
      const entry = sessions.get(sessionId);
      if (!entry || entry.dirty) return;
      entry.dirty = true;
      logger.info('session_marked_dirty', { sessionId, podName: entry.podName });
      resetIdleTimer(sessionId);
    },

    queueWork(sessionId: string, payload: string): void {
      pendingWork.set(sessionId, payload);
    },

    claimWork(sessionId: string): string | undefined {
      const payload = pendingWork.get(sessionId);
      if (payload !== undefined) pendingWork.delete(sessionId);
      return payload;
    },

    findSessionByToken(token: string): string | undefined {
      return tokenToSession.get(token);
    },

    activeSessions(): string[] {
      return [...sessions.keys()];
    },

    shutdown(): void {
      for (const [, entry] of sessions) {
        if (entry.warningTimer) clearTimeout(entry.warningTimer);
        if (entry.killTimer) clearTimeout(entry.killTimer);
        entry.kill();
      }
      sessions.clear();
      tokenToSession.clear();
      pendingWork.clear();
    },
  };
}
```

**Step 4: Run test to verify it passes**

Run: `npm test -- --bail tests/host/session-manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/session-manager.ts tests/host/session-manager.test.ts
git commit -m "feat: add unified SessionManager for both Docker and k8s sandboxes"
```

---

## Task 3: Add `fetch_work` IPC Handler

**Files:**
- Modify: `src/host/ipc-server.ts` (register handler)
- Test: integration test for fetch_work handler

**Step 1: Write the failing test**

```typescript
// In appropriate test file
it('fetch_work returns queued payload', async () => {
  // Create a session manager with queued work
  const sessionManager = createSessionManager({ idleTimeoutMs: 60000, warningLeadMs: 10000 });
  sessionManager.register('test-session', { pid: 1, kill: vi.fn() });
  sessionManager.queueWork('test-session', '{"message":"hello"}');

  // Call the fetch_work handler
  const handler = createFetchWorkHandler(sessionManager);
  const result = await handler({}, { sessionId: 'test-session', agentId: 'test' });
  expect(result).toEqual({ ok: true, payload: '{"message":"hello"}' });
});

it('fetch_work returns null when no work queued', async () => {
  const sessionManager = createSessionManager({ idleTimeoutMs: 60000, warningLeadMs: 10000 });
  sessionManager.register('test-session', { pid: 1, kill: vi.fn() });

  const handler = createFetchWorkHandler(sessionManager);
  const result = await handler({}, { sessionId: 'test-session', agentId: 'test' });
  expect(result).toEqual({ ok: true, payload: null });
});
```

**Step 2: Run test to verify it fails**

Expected: FAIL — `createFetchWorkHandler` not found

**Step 3: Add handler to `src/host/ipc-server.ts`**

In `createIPCHandler()`, add the `fetch_work` handler. The handler looks up the session by the calling agent's sessionId (from IPC context) and returns queued work.

```typescript
// In the handlers object composition:
...(opts?.sessionManager ? {
  fetch_work: async (_req: unknown, ctx: IPCContext) => {
    const payload = opts.sessionManager!.claimWork(ctx.sessionId);
    return { ok: true, payload: payload ?? null };
  },
} : {}),
```

Add `sessionManager` to `IPCHandlerOptions`:

```typescript
// In IPCHandlerOptions interface:
sessionManager?: SessionManager;
```

**Step 4: Run test to verify it passes**

Expected: PASS

**Step 5: Commit**

```bash
git add src/host/ipc-server.ts tests/
git commit -m "feat: add fetch_work IPC handler for multi-turn agent work loop"
```

---

## Task 4: Remove Apple Container Support

Do this early to simplify subsequent tasks (no need to handle 3 sandbox types).

**Files:**
- Delete: `src/providers/sandbox/apple.ts`
- Modify: `src/host/provider-map.ts` (remove `apple` from sandbox allowlist)
- Modify: `src/host/server-completions.ts` (remove bridge/listen mode logic)
- Modify: `src/agent/runner.ts` (remove listen mode)
- Modify: `src/types.ts` (remove `apple` from SandboxProviderName if typed)
- Modify: `src/config.ts` (remove `apple` from container sandbox set)
- Test: `npm run build` succeeds, `npm test` passes

**Step 1: Remove `apple` from provider-map**

In `src/host/provider-map.ts`, remove the `apple` line from the `sandbox` section:

```typescript
sandbox: {
  docker: '../providers/sandbox/docker.js',
  // apple line removed
  k8s: '../providers/sandbox/k8s.js',
},
```

**Step 2: Delete `src/providers/sandbox/apple.ts`**

**Step 3: Remove Apple Container bridge logic from `server-completions.ts`**

- Remove `bridgeSocketPath` handling (lines ~1280-1355)
- Remove `ipcReadyPromise` / `ipcReadyResolve` logic
- Remove `connectIPCBridge` import and usage
- Remove `ipcHandler` from `CompletionDeps` interface
- Simplify: all containers use the same IPC path (socket for Docker, HTTP for k8s)

**Step 4: Remove listen mode from `runner.ts`**

- Remove `AX_IPC_LISTEN` env check (lines 609-622)
- Remove `ipcListen` from `AgentConfig`
- The agent now has only 2 modes: HTTP (k8s) and socket (Docker)

**Step 5: Remove `apple` from config/types**

In `src/config.ts`, update the `containerSandboxes` set:
```typescript
const containerSandboxes = new Set(['docker', 'k8s']);
```

In `src/host/server-completions.ts`, update `CONTAINER_SANDBOXES`:
```typescript
const CONTAINER_SANDBOXES = new Set(['docker', 'k8s']);
```

And the proxy container check:
```typescript
const isContainerSandboxForProxy = config.providers.sandbox === 'docker';
```
(k8s uses the shared proxy started in server-k8s.ts, Docker uses per-session socket proxy)

**Step 6: Run build and tests**

Run: `npm run build && npm test`
Expected: PASS (no code references apple sandbox)

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove Apple Container sandbox support (Docker + k8s only)"
```

---

## Task 5: Update `runner.ts` for Universal Work Loop

After the first turn (delivered via stdin), ALL agents enter a work loop. Socket mode uses `fetch_work` IPC action; HTTP mode uses `GET /internal/work` (existing).

**Files:**
- Modify: `src/agent/runner.ts`
- Test: existing runner tests + new work loop test

**Step 1: Write the failing test**

```typescript
// Test that after run() completes, the runner calls fetch_work on the IPC client
it('enters work loop after first turn in socket mode', async () => {
  const mockClient = {
    call: vi.fn()
      .mockResolvedValueOnce({ ok: true }) // agent_response for first turn
      .mockResolvedValueOnce({ ok: true, payload: null }), // fetch_work returns null (exit)
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    setContext: vi.fn(),
  };
  // ... setup agent config with mockClient, verify fetch_work is called
});
```

**Step 2: Implement work loop for socket mode**

In `runner.ts`, after the default (socket) path reads stdin and calls `run()`:

```typescript
// After first turn completes in socket/default mode:
// Enter work loop — poll for subsequent turns via fetch_work IPC action
if (!payload.singleTurn && config.ipcClient) {
  const client = config.ipcClient;
  const maxIdlePolls = parseInt(process.env.AX_MAX_IDLE_POLLS || '', 10) || 2;
  let idlePolls = 0;

  while (true) {
    logger.info('work_loop_waiting');
    const result = await client.call({ action: 'fetch_work' }, 5 * 60 * 1000);

    if (!result.payload) {
      idlePolls++;
      logger.info('work_loop_no_work', { idlePolls, maxIdlePolls });
      if (idlePolls >= maxIdlePolls) {
        logger.info('idle_timeout_exit', { idlePolls });
        process.exit(0);
      }
      // Small delay before re-polling (socket mode doesn't have HTTP 404 retry built in)
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }
    idlePolls = 0;

    try {
      const workPayload = parseStdinPayload(result.payload as string);
      applyPayload(config, workPayload);
      await run(config);

      if (workPayload.singleTurn) {
        logger.info('single_turn_exit');
        process.exit(0);
      }
    } catch (err) {
      logger.error('work_loop_error', { error: (err as Error).message });
      try {
        await client.call({ action: 'agent_response', content: `Agent error: ${(err as Error).message}`, error: true });
      } catch { /* best effort */ }
    }
  }
}
```

Key change: the socket-mode path now behaves like the HTTP-mode path — both are session-long with a work loop. The only difference is the transport (socket IPC vs HTTP).

**Step 3: Ensure agent_response is sent for all modes**

Currently, `agent_response` is only sent in HTTP mode (runner.ts work loop error handler). The runners themselves need to send `agent_response` at the end of each turn. Check that `pi-session.ts` and `claude-code.ts` both call `agent_response`.

If runners don't already send `agent_response`, add it to the `run()` function or each runner's completion path.

**Step 4: Run tests**

Run: `npm test -- --bail tests/agent/`
Expected: PASS

**Step 5: Commit**

```bash
git add src/agent/runner.ts tests/agent/
git commit -m "feat: universal work loop — socket-mode agents stay alive across turns"
```

---

## Task 6: Update `processCompletion()` for Unified Response Model

**Files:**
- Modify: `src/host/server-completions.ts`

The goal: `processCompletion` always uses `agentResponsePromise` to get the response (via `agent_response` IPC action). Stdout collection becomes diagnostic-only. The session manager handles work dispatch for subsequent turns.

**Step 1: Refactor `CompletionDeps` to use SessionManager**

Replace the individual callbacks (`queueWork`, `getSessionPod`, `registerSessionPod`, `removeSessionPod`) with a single `sessionManager` reference:

```typescript
export interface CompletionDeps {
  // ... existing fields ...
  /** Unified session manager — handles both Docker and k8s sandboxes. */
  sessionManager?: SessionManager;
  // Remove: queueWork, getSessionPod, registerSessionPod, removeSessionPod
  // Remove: ipcHandler (was Apple Container only)
}
```

**Step 2: Always set up `agentResponsePromise`**

Currently, `agentResponsePromise` is only set in k8s mode (server-k8s.ts processCompletionForSession). Move this into `processCompletion` itself:

```typescript
// In processCompletion, after sandbox path setup:
let agentResponseResolve: ((content: string) => void) | undefined;
let agentResponseReject: ((err: Error) => void) | undefined;
const agentResponsePromise = new Promise<string>((resolve, reject) => {
  agentResponseResolve = resolve;
  agentResponseReject = reject;
});
agentResponsePromise.catch(() => {}); // prevent unhandled rejection
```

**Step 3: Wrap IPC handler to intercept `agent_response`**

Move the `wrappedHandleIPC` logic from `server-k8s.ts` into `processCompletion`:

```typescript
// Wrap handleIPC to intercept agent_response
const wrappedHandleIPC = async (raw: string, ctx: IPCContext): Promise<string> => {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.action === 'agent_response') {
      agentResponseResolve?.(parsed.content ?? '');
      return JSON.stringify({ ok: true });
    }
    if (DIRTY_ACTIONS.has(parsed.action)) {
      deps.sessionManager?.markDirty(sessionId);
    }
  } catch { /* fall through */ }
  return handleIPC(raw, ctx);
};
```

**Step 4: Session reuse logic**

Check `sessionManager.has(sessionId)` instead of `deps.getSessionPod`:

```typescript
const existingSession = deps.sessionManager?.get(sessionId);
if (existingSession) {
  // Reuse — queue work for agent to fetch
  deps.sessionManager!.queueWork(sessionId, stdinPayload);
  // Wait for agent_response
  response = await agentResponsePromise;
} else {
  // Spawn new sandbox, deliver work via stdin
  proc = await agentSandbox.spawn(sandboxConfig);
  deps.sessionManager?.register(sessionId, { pid: proc.pid, kill: proc.kill, podName: proc.podName });
  proc.stdin.write(stdinPayload);
  proc.stdin.end();
  // Wait for agent_response via IPC
  response = await agentResponsePromise;
}
```

**Step 5: Remove stdout response parsing**

The `stdoutDone` promise and `response += chunk` logic become diagnostic-only (or can be removed entirely since stderr already captures diagnostics).

**Step 6: Run tests**

Run: `npm test -- --bail`
Expected: PASS

**Step 7: Commit**

```bash
git add src/host/server-completions.ts
git commit -m "refactor: unified response model — always use agent_response IPC, drop stdout parsing"
```

---

## Task 7: Build Unified `server.ts`

Merge `server-local.ts` and `server-k8s.ts` into a single `server.ts`.

**Files:**
- Create: `src/host/server.ts` (unified)
- Modify: `src/cli/serve.ts` (or wherever server is started)
- Modify: `src/main.ts` (entry point)
- Test: existing server tests pass

**Step 1: Create unified `server.ts`**

Structure:
```typescript
// src/host/server.ts — Unified AX server.
//
// Single HTTP server for both local and k8s deployment.
// Transport listeners (config-driven):
//   Local: Unix socket (~/.ax/ax.sock) + optional TCP port
//   K8s: TCP on 0.0.0.0:PORT
//
// Internal routes (/internal/ipc, /internal/work, /internal/llm-proxy)
// are always registered. In Docker mode they're unused (agent uses socket).
// In k8s mode they're the primary IPC channel.

export async function createServer(config, opts): Promise<AxServer> {
  // 1. Load providers
  // 2. Event bus + console
  // 3. Session manager (always created)
  // 4. initHostCore (shared init)
  // 5. Web proxy (always for container sandboxes, shared instance)
  // 6. Shared credential registry
  // 7. Webhook + admin handlers
  // 8. processCompletionForSession wrapper (turn token, session manager)
  // 9. Internal routes handler (handleInternalRoutes)
  // 10. Request handler (createRequestHandler with extraRoutes)
  // 11. Listen: Unix socket (local) or TCP (k8s) based on config
  // 12. Scheduler + channel providers
  // 13. Shared agents
  // 14. Graceful shutdown
}
```

Key decisions:
- **Local mode detection:** `bindHost !== '0.0.0.0'` or explicit `opts.socketPath`
- **Unix socket:** Created when `opts.socketPath` is provided (local mode)
- **TCP:** Always created (admin dashboard / k8s external access)
- **Internal routes:** Always registered (no conditional)
- **Session manager:** Always created, configured from `config.sandbox`
- **Web proxy:** Shared instance when k8s (TCP port 3128), per-session socket when Docker

The `processCompletionForSession` wrapper from `server-k8s.ts` (lines 168-311) moves into `server.ts` but is simplified:
- No `isK8s` check — always set up `agentResponsePromise`
- Always register turn token in `activeTokens`
- Session manager handles both Docker and k8s sessions
- `agentResponsePromise` resolution via IPC `agent_response` interceptor

**Step 2: Update imports in CLI/main**

Update `src/cli/serve.ts` (or equivalent) to import from `./server.js` instead of `./server-local.js`.

For k8s entry point, update the import or use the same `createServer` with k8s-appropriate options.

**Step 3: Run build and tests**

Run: `npm run build && npm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/host/server.ts src/cli/ src/main.ts
git commit -m "feat: unified server.ts — merge local and k8s server entry points"
```

---

## Task 8: Make Web Proxy + Placeholders Mandatory

**Files:**
- Modify: `src/host/server-completions.ts`
- Modify: `src/config.ts`
- Modify: `src/host/credential-placeholders.ts`

**Step 1: Remove `web_proxy` config toggle**

In `src/config.ts`, the auto-enable logic already forces `web_proxy: true` for container sandboxes. Make it unconditional for Docker/k8s:

```typescript
// Remove the web_proxy config option — always true for container sandboxes
if (containerSandboxes.has(config.providers.sandbox)) {
  (config as any).web_proxy = true;
}
```

**Step 2: Remove direct credential injection fallback**

In `server-completions.ts`, the credential loading currently has two paths:
```typescript
if (config.web_proxy) {
  credentialMap.register(envName, realValue); // placeholder
} else {
  credentialEnv[envName] = realValue; // direct injection
}
```

Remove the else branch — always use placeholders for container sandboxes.

**Step 3: Remove `web_proxy` from Config type**

In `src/types.ts`, remove `web_proxy?: boolean` from Config (or mark as deprecated/always-true).

**Step 4: Run tests**

Run: `npm test -- --bail`
Expected: PASS

**Step 5: Commit**

```bash
git add src/host/server-completions.ts src/config.ts src/types.ts
git commit -m "refactor: make web proxy + credential placeholders mandatory for container sandboxes"
```

---

## Task 9: Delete Old Files + Update Imports

**Files:**
- Delete: `src/host/server-local.ts`
- Delete: `src/host/server-k8s.ts`
- Delete: `src/host/session-pod-manager.ts`
- Modify: All files that import from deleted modules

**Step 1: Find all imports of deleted modules**

Search for:
- `'./server-local'` / `'./server-local.js'`
- `'./server-k8s'` / `'./server-k8s.js'`
- `'./session-pod-manager'` / `'./session-pod-manager.js'`

Update to import from `'./server.js'` or `'./session-manager.js'`.

**Step 2: Delete files**

```bash
rm src/host/server-local.ts
rm src/host/server-k8s.ts
rm src/host/session-pod-manager.ts
```

**Step 3: Run build**

Run: `npm run build`
Expected: PASS (no broken imports)

**Step 4: Run tests**

Run: `npm test`
Expected: PASS

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete server-local.ts, server-k8s.ts, session-pod-manager.ts (replaced by unified server.ts + session-manager.ts)"
```

---

## Task 10: Update Helm Chart Entry Point

**Files:**
- Modify: `charts/ax/values.yaml` (or templates)
- Modify: `charts/ax/templates/deployment.yaml` (if entry point is there)

**Step 1: Update command**

Change the host pod command from:
```yaml
command: ["node", "dist/host/server-k8s.js"]
```
to:
```yaml
command: ["node", "dist/cli/index.js", "serve", "--port", "8080"]
```

Or if the unified server has its own entry point:
```yaml
command: ["node", "dist/host/server.js"]
```

**Step 2: Verify chart renders**

Run: `helm template charts/ax/ | grep command`
Expected: new entry point

**Step 3: Commit**

```bash
git add charts/
git commit -m "chore: update Helm chart entry point to unified server.ts"
```

---

## Testing Focus (Post-Implementation)

After all tasks are complete, verify these scenarios:

1. **Docker socket bridge + MITM proxy** — credential placeholder replacement works
2. **Session-long Docker containers** — agent stays alive, receives second turn via `fetch_work`
3. **Idle timeout** — Docker container killed after inactivity (dirty vs clean)
4. **`fetch_work` over Unix socket** — agent polls, receives work, processes, responds
5. **K8s pods with unified `processCompletion`** — regression test (no behavior change)
6. **Fast path bypass** — in-process LLM loop still works (no sandbox)
7. **Graceful shutdown** — all sessions cleaned up

## Net Impact

- **Files deleted:** 4 (`server-local.ts`, `server-k8s.ts`, `session-pod-manager.ts`, `apple.ts`)
- **Files created:** 2 (`server.ts`, `session-manager.ts`)
- **Estimated LOC:** Delete ~1200, add ~500. Net reduction ~700 lines.
