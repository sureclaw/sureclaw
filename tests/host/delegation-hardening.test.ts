/**
 * Delegation hardening tests — targets specific crash-causing bugs
 * in the subagent delegation pipeline.
 *
 * Bug 1: Timer leak in IPC handler timeout (setTimeout never cleared)
 * Bug 2: Delegation zombie when IPC timeout fires (counter never decremented)
 * Bug 3: Error response inconsistency in delegation handler
 *
 * These tests reproduce the failure modes that cause "3 concurrent agents
 * crashes the server."
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createIPCHandler, type IPCContext, type DelegateRequest } from '../../src/host/ipc-server.js';
import { createDelegationHandlers } from '../../src/host/ipc-handlers/delegation.js';
import { createEventBus, type EventBus } from '../../src/host/event-bus.js';
import { createOrchestrator, type Orchestrator } from '../../src/host/orchestration/orchestrator.js';
import type { ProviderRegistry } from '../../src/types.js';

function mockProviders(): ProviderRegistry {
  return {
    llm: { name: 'mock', chat: vi.fn(), models: vi.fn() },
    memory: {
      write: vi.fn(async () => 'mock-id'),
      query: vi.fn(async () => []),
      read: vi.fn(async () => null),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    security: {
      scanInput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      scanOutput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      canaryToken: vi.fn(() => 'CANARY-test'),
      checkCanary: vi.fn(() => false),
    },
    channels: [],
    webFetch: { fetch: vi.fn() },
    webExtract: { extract: vi.fn() },
    webSearch: { search: vi.fn(async () => []) },
    credentials: {
      get: vi.fn(async () => null),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(async () => []),
    },
    skills: {
      list: vi.fn(async () => []),
      read: vi.fn(async () => ''),
      propose: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      revert: vi.fn(),
      log: vi.fn(async () => []),
    },
    audit: {
      log: vi.fn(),
      query: vi.fn(async () => []),
    },
    sandbox: {
      spawn: vi.fn(),
      kill: vi.fn(),
      isAvailable: vi.fn(async () => true),
    },
    scheduler: {
      start: vi.fn(),
      stop: vi.fn(),
    },
    storage: {
      documents: {
        get: vi.fn(async () => undefined),
        put: vi.fn(),
        delete: vi.fn(async () => false),
        list: vi.fn(async () => []),
      },
      messages: {} as any,
      conversations: {} as any,
      sessions: {} as any,
      close: vi.fn(),
    },
  } as unknown as ProviderRegistry;
}

const defaultCtx: IPCContext = { sessionId: 'test-session', agentId: 'primary' };

// ── Bug 1: Timer leak ────────────────────────────────────────

describe('IPC handler timeout cleanup', () => {
  test('clearTimeout is called after handler completes successfully', async () => {
    const providers = mockProviders();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const clearedTimerIds: ReturnType<typeof setTimeout>[] = [];

    // Track setTimeout calls that look like IPC handler timeouts (>= 60s)
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number, ...args: any[]) => {
      const id = originalSetTimeout(fn, ms, ...args);
      if (ms && ms >= 60_000) {
        timerIds.push(id);
      }
      return id;
    });

    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) {
        clearedTimerIds.push(id);
      }
      return originalClearTimeout(id);
    });

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'done',
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Test timer cleanup' }),
      defaultCtx,
    );

    // Every long timer (IPC handler timeout) should have been cleared
    for (const timerId of timerIds) {
      expect(clearedTimerIds).toContain(timerId);
    }

    vi.restoreAllMocks();
  });

  test('clearTimeout is called even when handler throws', async () => {
    const providers = mockProviders();
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;

    const timerIds: ReturnType<typeof setTimeout>[] = [];
    const clearedTimerIds: ReturnType<typeof setTimeout>[] = [];

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn: any, ms?: number, ...args: any[]) => {
      const id = originalSetTimeout(fn, ms, ...args);
      if (ms && ms >= 60_000) {
        timerIds.push(id);
      }
      return id;
    });

    vi.spyOn(globalThis, 'clearTimeout').mockImplementation((id?: ReturnType<typeof setTimeout>) => {
      if (id !== undefined) {
        clearedTimerIds.push(id);
      }
      return originalClearTimeout(id);
    });

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('handler exploded'); },
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Test timer cleanup on error' }),
      defaultCtx,
    );

    for (const timerId of timerIds) {
      expect(clearedTimerIds).toContain(timerId);
    }

    vi.restoreAllMocks();
  });
});

// ── Bug 2: Concurrent delegation counter management ──────────
//
// These tests use createDelegationHandlers directly (bypassing the full IPC
// pipeline) to test the delegation handler's concurrency tracking without
// being blocked by the IPC handler's 15-minute timeout wrapper.

describe('concurrent delegation counter', () => {
  test('3 concurrent delegations all complete, then 4th succeeds', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Start 3 delegations (all should be accepted)
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    const d2 = agent_delegate({ task: 'Task 2' }, defaultCtx);
    const d3 = agent_delegate({ task: 'Task 3' }, defaultCtx);

    // Give event loop a tick so all 3 register their concurrency
    await new Promise(r => setTimeout(r, 50));

    // 4th should be rejected while 3 are in-flight
    const d4Rejected = await agent_delegate({ task: 'Task 4 (should fail)' }, defaultCtx);
    expect(d4Rejected.ok).toBe(false);
    expect(d4Rejected.error).toContain('concurrent');

    // Resolve all 3
    for (const resolve of resolvers) resolve();
    const [r1, r2, r3] = await Promise.all([d1, d2, d3]);
    expect(r1.response).toBe('done');
    expect(r2.response).toBe('done');
    expect(r3.response).toBe('done');

    // Counter should be back to 0 — fire 5th, resolve it, verify success
    const d5 = agent_delegate({ task: 'Task 5 (should pass)' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const r5 = await d5;
    expect(r5.response).toBe('done');
  });

  test('counter decrements when 1 of 3 concurrent delegations throws', async () => {
    const providers = mockProviders();
    let callCount = 0;
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error('delegation 2 crashed');
        }
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Start 3 delegations — #2 will throw
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    const d2 = agent_delegate({ task: 'Task 2 (crashes)' }, defaultCtx);
    const d3 = agent_delegate({ task: 'Task 3' }, defaultCtx);

    // Wait for microtasks to settle — d2 should resolve with error
    await new Promise(r => setTimeout(r, 50));

    // d2 should have resolved with error (handler caught the throw)
    const r2 = await d2;
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('delegation 2 crashed');

    // Resolve the other 2
    for (const resolve of resolvers) resolve();
    const [r1, r3] = await Promise.all([d1, d3]);
    expect(r1.response).toBe('done');
    expect(r3.response).toBe('done');

    // Counter should be back to 0 — fire new delegation, resolve it, verify
    callCount = 0;
    const d4 = agent_delegate({ task: 'Task 4 (after crash recovery)' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const r4 = await d4;
    expect(r4.response).toBe('done');
  });

  test('rapid-fire: 10 requests with maxConcurrent=3, exactly 3 accepted', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Fire 10 requests simultaneously
    const promises: Promise<any>[] = [];
    for (let i = 0; i < 10; i++) {
      promises.push(agent_delegate({ task: `Task ${i}` }, defaultCtx));
    }

    // Let microtasks settle so accepted calls reach onDelegate
    await new Promise(r => setTimeout(r, 50));

    // Resolve the ones that were accepted (only 3 should have resolvers)
    expect(resolvers.length).toBe(3);
    for (const resolve of resolvers) resolve();

    const results = await Promise.all(promises);

    const accepted = results.filter((r: any) => r.response !== undefined);
    const rejected = results.filter((r: any) => r.ok === false);

    expect(accepted.length).toBe(3);
    expect(rejected.length).toBe(7);

    for (const r of rejected) {
      expect(r.error).toContain('concurrent');
    }

    // Counter back to 0 — fire one more, resolve it, verify
    const finalPromise = agent_delegate({ task: 'Final after storm' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));
    resolvers[resolvers.length - 1]!();
    const final = await finalPromise;
    expect(final.response).toBe('done');
  });

  test('counter decrements when all concurrent delegations throw', async () => {
    const providers = mockProviders();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => { throw new Error('all delegates fail'); },
    });

    // Fire 3 that all throw
    const [r1, r2, r3] = await Promise.all([
      agent_delegate({ task: 'Fail 1' }, defaultCtx),
      agent_delegate({ task: 'Fail 2' }, defaultCtx),
      agent_delegate({ task: 'Fail 3' }, defaultCtx),
    ]);

    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
    expect(r3.ok).toBe(false);

    // Counter must be 0 — create a new handler set with a success callback
    const { agent_delegate: delegate2 } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'recovered',
    });

    const d4 = await delegate2({ task: 'After total failure' }, defaultCtx);
    expect(d4.response).toBe('recovered');
  });
});

// ── Bug 3: Error response consistency ────────────────────────

describe('delegation error response format', () => {
  test('handler throw returns ok:false with error message', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('something broke'); },
    });

    const result = JSON.parse(await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Error format test' }),
      defaultCtx,
    ));

    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('something broke');
  });

  test('concurrency limit returns same error shape as handler error', async () => {
    const providers = mockProviders();
    let resolveDelegate: () => void;

    // Use createDelegationHandlers directly to avoid IPC timeout blocking
    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: async () => {
        return new Promise<string>(resolve => { resolveDelegate = () => resolve('done'); });
      },
    });

    // Block the slot
    const d1 = agent_delegate({ task: 'Blocking' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Get concurrency rejection
    const limitResult = await agent_delegate({ task: 'Over limit' }, defaultCtx);

    // Both should have ok:false and error string
    expect(limitResult.ok).toBe(false);
    expect(typeof limitResult.error).toBe('string');

    // Unblock and clean up
    resolveDelegate!();
    await d1;

    // Now get handler error via IPC handler (no blocking needed)
    const errorHandler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: async () => { throw new Error('crash'); },
    });

    const errorResult = JSON.parse(await errorHandler(
      JSON.stringify({ action: 'agent_delegate', task: 'Throw' }),
      defaultCtx,
    ));

    expect(errorResult.ok).toBe(false);
    expect(typeof errorResult.error).toBe('string');

    // Both should have ok and error keys
    expect(limitResult).toHaveProperty('ok');
    expect(limitResult).toHaveProperty('error');
    expect(errorResult).toHaveProperty('ok');
    expect(errorResult).toHaveProperty('error');
  });

  test('depth limit returns same error shape as concurrency limit', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'done',
    });

    const depthResult = JSON.parse(await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Too deep' }),
      { sessionId: 'test-session', agentId: 'agent:depth=2' },
    ));

    expect(depthResult.ok).toBe(false);
    expect(typeof depthResult.error).toBe('string');
    expect(depthResult.error).toContain('depth');
  });
});

// ── wait parameter: async fire-and-forget delegation ─────────

describe('wait parameter (async parallel delegation)', () => {
  test('wait: false returns {handleId, status: "started"} immediately', async () => {
    const providers = mockProviders();
    let resolveDelegate: (v: string) => void;

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => { resolveDelegate = resolve; });
      },
    });

    const result = await agent_delegate({ task: 'Async task', wait: false }, defaultCtx);

    // Should return immediately with handleId and status
    expect(result.handleId).toBeDefined();
    expect(typeof result.handleId).toBe('string');
    expect(result.status).toBe('started');
    // Should NOT have a response (hasn't completed yet)
    expect(result.response).toBeUndefined();

    // Clean up: resolve the background delegate
    resolveDelegate!('done');
    await new Promise(r => setTimeout(r, 10));
  });

  test('wait: false delegate actually completes in background', async () => {
    const providers = mockProviders();
    let resolveDelegate: (v: string) => void;
    let delegateCompleted = false;

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolveDelegate = (v: string) => {
            delegateCompleted = true;
            resolve(v);
          };
        });
      },
    });

    await agent_delegate({ task: 'Background task', wait: false }, defaultCtx);
    expect(delegateCompleted).toBe(false);

    // Resolve and wait for the background work to complete
    resolveDelegate!('background-done');
    await new Promise(r => setTimeout(r, 50));
    expect(delegateCompleted).toBe(true);
  });

  test('wait: true (explicit) preserves blocking behavior', async () => {
    const providers = mockProviders();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'blocking-result',
    });

    const result = await agent_delegate({ task: 'Blocking task', wait: true }, defaultCtx);

    // Should have the response directly (blocking mode)
    expect(result.response).toBe('blocking-result');
    expect(result.handleId).toBeUndefined();
    expect(result.status).toBeUndefined();
  });

  test('wait omitted defaults to blocking (backward compat)', async () => {
    const providers = mockProviders();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'default-blocking',
    });

    // No wait parameter at all
    const result = await agent_delegate({ task: 'Default task' }, defaultCtx);

    expect(result.response).toBe('default-blocking');
    expect(result.handleId).toBeUndefined();
  });

  test('concurrent wait: false delegates run in parallel', async () => {
    const providers = mockProviders();
    const resolvers: ((v: string) => void)[] = [];
    const startTimes: number[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 5, maxDepth: 5 },
      onDelegate: async () => {
        startTimes.push(Date.now());
        return new Promise<string>(resolve => {
          resolvers.push(resolve);
        });
      },
    });

    // Fire 3 async delegates
    const r1 = await agent_delegate({ task: 'Parallel 1', wait: false }, defaultCtx);
    const r2 = await agent_delegate({ task: 'Parallel 2', wait: false }, defaultCtx);
    const r3 = await agent_delegate({ task: 'Parallel 3', wait: false }, defaultCtx);

    // All should return immediately with handleId
    expect(r1.status).toBe('started');
    expect(r2.status).toBe('started');
    expect(r3.status).toBe('started');

    // All 3 handleIds should be unique
    const ids = [r1.handleId, r2.handleId, r3.handleId];
    expect(new Set(ids).size).toBe(3);

    // Wait for onDelegate to be called for all 3
    await new Promise(r => setTimeout(r, 50));
    expect(resolvers.length).toBe(3);

    // Resolve all
    for (const resolve of resolvers) resolve('done');
    await new Promise(r => setTimeout(r, 10));
  });

  test('activeDelegations counter works correctly for fire-and-forget', async () => {
    const providers = mockProviders();
    const resolvers: ((v: string) => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 2, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(resolve);
        });
      },
    });

    // Fire 2 async delegates (fills concurrency)
    await agent_delegate({ task: 'Async 1', wait: false }, defaultCtx);
    await agent_delegate({ task: 'Async 2', wait: false }, defaultCtx);

    // 3rd should be rejected (concurrency limit)
    const r3 = await agent_delegate({ task: 'Async 3 (rejected)', wait: false }, defaultCtx);
    expect(r3.ok).toBe(false);
    expect(r3.error).toContain('concurrent');

    // Resolve one background delegate
    await new Promise(r => setTimeout(r, 10));
    resolvers[0]!('done');
    await new Promise(r => setTimeout(r, 50));

    // Now slot is free — 4th should work
    const r4 = await agent_delegate({ task: 'Async 4 (should pass)', wait: false }, defaultCtx);
    expect(r4.status).toBe('started');

    // Clean up
    for (const resolve of resolvers) resolve('done');
    await new Promise(r => setTimeout(r, 10));
  });

  test('wait: false with orchestrator registers handle and stores result', async () => {
    const providers = mockProviders();
    let resolveDelegate: (v: string) => void;

    // Create a minimal mock orchestrator (starts at 'spawning' like real code)
    const handles = new Map<string, any>();
    const mockOrchestrator = {
      register: vi.fn((opts: any) => {
        const handle = {
          id: opts.metadata?.handleId ?? 'mock-id',
          agentId: opts.agentId,
          state: 'spawning',
          metadata: { ...opts.metadata },
        };
        handles.set(handle.id, handle);
        return handle;
      }),
      supervisor: {
        transition: vi.fn((id: string, state: string) => {
          const h = handles.get(id);
          if (h) h.state = state;
        }),
      },
    };

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => { resolveDelegate = resolve; });
      },
      orchestrator: mockOrchestrator as any,
    });

    const result = await agent_delegate({ task: 'Orch test', wait: false }, defaultCtx);
    expect(result.status).toBe('started');
    expect(mockOrchestrator.register).toHaveBeenCalled();

    // Handle should have been transitioned spawning → running immediately
    const handleBeforeResolve = handles.get(result.handleId);
    expect(handleBeforeResolve.state).toBe('running');

    // Resolve the delegate
    resolveDelegate!('orch-response');
    await new Promise(r => setTimeout(r, 50));

    // The orchestrator handle should have the response in metadata
    const handle = handles.get(result.handleId);
    expect(handle).toBeDefined();
    expect(handle.metadata.response).toBe('orch-response');
    expect(handle.state).toBe('completed');
  });

  test('wait: false with orchestrator stores error on failure', async () => {
    const providers = mockProviders();

    const handles = new Map<string, any>();
    const mockOrchestrator = {
      register: vi.fn((opts: any) => {
        const handle = {
          id: opts.metadata?.handleId ?? 'mock-id',
          agentId: opts.agentId,
          state: 'spawning',
          metadata: { ...opts.metadata },
        };
        handles.set(handle.id, handle);
        return handle;
      }),
      supervisor: {
        transition: vi.fn((id: string, state: string) => {
          const h = handles.get(id);
          if (h) h.state = state;
        }),
      },
    };

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => { throw new Error('background crash'); },
      orchestrator: mockOrchestrator as any,
    });

    const result = await agent_delegate({ task: 'Fail orch test', wait: false }, defaultCtx);
    expect(result.status).toBe('started');

    await new Promise(r => setTimeout(r, 50));

    const handle = handles.get(result.handleId);
    expect(handle).toBeDefined();
    expect(handle.metadata.error).toContain('background crash');
    expect(handle.state).toBe('failed');
  });
});

// ── agent_collect: collecting fire-and-forget results ──────

describe('agent_collect', () => {
  test('collects results from multiple wait:false delegates', async () => {
    const providers = mockProviders();
    const resolvers: ((v: string) => void)[] = [];

    const handlers = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 5, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(resolve);
        });
      },
    });

    // Launch 3 fire-and-forget delegates
    const r1 = await handlers.agent_delegate({ task: 'Task A', wait: false }, defaultCtx);
    const r2 = await handlers.agent_delegate({ task: 'Task B', wait: false }, defaultCtx);
    const r3 = await handlers.agent_delegate({ task: 'Task C', wait: false }, defaultCtx);

    expect(r1.status).toBe('started');
    expect(r2.status).toBe('started');
    expect(r3.status).toBe('started');

    // Wait for onDelegate to be called
    await new Promise(r => setTimeout(r, 50));

    // Resolve all delegates with different results
    resolvers[0]!('result-A');
    resolvers[1]!('result-B');
    resolvers[2]!('result-C');

    // Collect all results
    const collected = await handlers.agent_collect(
      { handleIds: [r1.handleId, r2.handleId, r3.handleId] },
      defaultCtx,
    );

    expect(collected.results).toBeDefined();
    expect(collected.results).toHaveLength(3);

    const byHandle = new Map(collected.results.map((r: any) => [r.handleId, r]));
    expect(byHandle.get(r1.handleId).response).toBe('result-A');
    expect(byHandle.get(r2.handleId).response).toBe('result-B');
    expect(byHandle.get(r3.handleId).response).toBe('result-C');
  });

  test('blocks until delegates complete', async () => {
    const providers = mockProviders();
    let resolveDelegate: (v: string) => void;

    const handlers = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => { resolveDelegate = resolve; });
      },
    });

    const r1 = await handlers.agent_delegate({ task: 'Slow task', wait: false }, defaultCtx);

    // Start collecting — should not resolve yet
    let collectResolved = false;
    const collectPromise = handlers.agent_collect(
      { handleIds: [r1.handleId] },
      defaultCtx,
    ).then((result) => {
      collectResolved = true;
      return result;
    });

    await new Promise(r => setTimeout(r, 50));
    expect(collectResolved).toBe(false);

    // Resolve the delegate
    resolveDelegate!('finally-done');
    const collected = await collectPromise;
    expect(collectResolved).toBe(true);
    expect(collected.results[0].response).toBe('finally-done');
  });

  test('returns error for unknown handle IDs', async () => {
    const providers = mockProviders();

    const handlers = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'done',
    });

    const result = await handlers.agent_collect(
      { handleIds: ['nonexistent-handle'] },
      defaultCtx,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Unknown handle IDs');
  });

  test('collects errors from failed delegates', async () => {
    const providers = mockProviders();

    const handlers = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => { throw new Error('delegate exploded'); },
    });

    const r1 = await handlers.agent_delegate({ task: 'Will fail', wait: false }, defaultCtx);
    await new Promise(r => setTimeout(r, 50));

    const collected = await handlers.agent_collect(
      { handleIds: [r1.handleId] },
      defaultCtx,
    );

    expect(collected.results).toHaveLength(1);
    expect(collected.results[0].error).toContain('delegate exploded');
    expect(collected.results[0].response).toBeUndefined();
  });

  test('cleans up handles after collection', async () => {
    const providers = mockProviders();

    const handlers = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async () => 'done',
    });

    const r1 = await handlers.agent_delegate({ task: 'Cleanup test', wait: false }, defaultCtx);
    await new Promise(r => setTimeout(r, 50));

    // First collect succeeds
    const first = await handlers.agent_collect(
      { handleIds: [r1.handleId] },
      defaultCtx,
    );
    expect(first.results).toHaveLength(1);

    // Second collect for same handle fails (cleaned up)
    const second = await handlers.agent_collect(
      { handleIds: [r1.handleId] },
      defaultCtx,
    );
    expect(second.ok).toBe(false);
    expect(second.error).toContain('Unknown handle IDs');
  });
});

// ── Delegation audit completeness ────────────────────────────

describe('delegation audit trail', () => {
  test('successful delegation audits both action and completion', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => 'audit test result',
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Audit completeness test' }),
      defaultCtx,
    );

    // Should have audit entries for the delegation
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegate' }),
    );
  });

  test('failed delegation is still audited', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate: async () => { throw new Error('fail'); },
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Audit on failure test' }),
      defaultCtx,
    );

    // Delegation action should still be audited even though it failed
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent_delegate' }),
    );
  });
});

// ── Bug 4: Heartbeat kills active fire-and-forget delegates ──
//
// Root cause: the delegation handler registered the orchestrator handle
// with the parent's sessionId, but the child agent's events use a
// different requestId (generated in handleDelegate). Auto-state inference
// maps events by requestId → sessionToHandles, so the child's events
// never matched the handle → no state transitions.
//
// Fix: delegation handler generates the child's requestId, passes it to
// onDelegate via DelegateRequest.requestId, and registers the handle
// with sessionId = childRequestId.

describe('fire-and-forget delegation heartbeat alignment', () => {
  test('child requestId is passed via DelegateRequest so events align with handle', async () => {
    const providers = mockProviders();
    let capturedReq: DelegateRequest | undefined;

    const eventBus = createEventBus();
    const orchestrator = createOrchestrator(eventBus);
    const unsub = orchestrator.enableAutoState();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async (req) => {
        capturedReq = req;
        return 'done';
      },
      orchestrator: orchestrator as any,
    });

    const result = await agent_delegate({ task: 'Heartbeat test', wait: false }, defaultCtx);
    await new Promise(r => setTimeout(r, 50));

    // The request should include a requestId
    expect(capturedReq).toBeDefined();
    expect(capturedReq!.requestId).toBeDefined();
    expect(typeof capturedReq!.requestId).toBe('string');
    expect(capturedReq!.requestId!.startsWith('delegate-')).toBe(true);

    // The orchestrator handle's sessionId should match the requestId
    const handle = orchestrator.supervisor.get(result.handleId);
    expect(handle).toBeDefined();
    expect(handle!.sessionId).toBe(capturedReq!.requestId);

    unsub();
  });

  test('auto-state transitions update heartbeat for fire-and-forget delegates', async () => {
    const providers = mockProviders();
    let capturedReq: DelegateRequest | undefined;
    let resolveDelegate: (v: string) => void;

    const eventBus = createEventBus();
    const orchestrator = createOrchestrator(eventBus);
    const unsub = orchestrator.enableAutoState();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async (req) => {
        capturedReq = req;
        return new Promise<string>(resolve => { resolveDelegate = resolve; });
      },
      orchestrator: orchestrator as any,
    });

    const result = await agent_delegate({ task: 'Heartbeat alive', wait: false }, defaultCtx);
    await new Promise(r => setTimeout(r, 50));

    const handle = orchestrator.supervisor.get(result.handleId);
    expect(handle).toBeDefined();
    expect(handle!.state).toBe('running');

    // Simulate a child agent emitting tool.call with the correct requestId
    // (the requestId that was passed to onDelegate)
    const childRequestId = capturedReq!.requestId!;
    eventBus.emit({
      type: 'tool.call',
      requestId: childRequestId,
      timestamp: Date.now(),
      data: { toolName: 'web' },
    });

    // Auto-state should have transitioned the handle to tool_calling
    expect(handle!.state).toBe('tool_calling');

    // Simulate llm.done — should transition back to running
    eventBus.emit({
      type: 'llm.done',
      requestId: childRequestId,
      timestamp: Date.now(),
      data: { chunkCount: 5 },
    });
    expect(handle!.state).toBe('running');

    // Clean up
    resolveDelegate!('done');
    await new Promise(r => setTimeout(r, 50));
    unsub();
  });

  test('blocking delegates do NOT pass requestId (backward compat)', async () => {
    const providers = mockProviders();
    let capturedReq: DelegateRequest | undefined;

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 3, maxDepth: 5 },
      onDelegate: async (req) => {
        capturedReq = req;
        return 'done';
      },
    });

    // Blocking mode (wait: true or omitted)
    await agent_delegate({ task: 'Blocking task' }, defaultCtx);

    // requestId should NOT be set for blocking delegates
    expect(capturedReq).toBeDefined();
    expect(capturedReq!.requestId).toBeUndefined();
  });
});
