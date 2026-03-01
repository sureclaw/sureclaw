/**
 * Delegation wait queue tests — verifies the wait-with-timeout behavior
 * added to the delegation handler.
 *
 * When queueTimeoutMs > 0, requests at capacity wait for a slot instead
 * of being immediately rejected. Tests cover:
 * - Wait and acquire slot when one frees up
 * - Timeout when no slot frees in time
 * - FIFO ordering of waiters
 * - Legacy behavior (queueTimeoutMs = 0) preserved
 */

import { describe, test, expect, vi } from 'vitest';
import { createDelegationHandlers } from '../../src/host/ipc-handlers/delegation.js';
import type { IPCContext } from '../../src/host/ipc-server.js';
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
    scanner: {
      scanInput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      scanOutput: vi.fn(async () => ({ verdict: 'PASS' as const })),
      canaryToken: vi.fn(() => 'CANARY-test'),
      checkCanary: vi.fn(() => false),
    },
    channels: [],
    web: { fetch: vi.fn(), search: vi.fn(async () => []) },
    browser: {
      launch: vi.fn(), navigate: vi.fn(), snapshot: vi.fn(),
      click: vi.fn(), type: vi.fn(), screenshot: vi.fn(), close: vi.fn(),
    },
    credentials: {
      get: vi.fn(async () => null), set: vi.fn(),
      delete: vi.fn(), list: vi.fn(async () => []),
    },
    skills: {
      list: vi.fn(async () => []), read: vi.fn(async () => ''),
      propose: vi.fn(), approve: vi.fn(), reject: vi.fn(),
      revert: vi.fn(), log: vi.fn(async () => []),
    },
    audit: { log: vi.fn(), query: vi.fn(async () => []) },
    sandbox: { spawn: vi.fn(), kill: vi.fn(), isAvailable: vi.fn(async () => true) },
    scheduler: { start: vi.fn(), stop: vi.fn() },
  } as unknown as ProviderRegistry;
}

const defaultCtx: IPCContext = { sessionId: 'test-session', agentId: 'primary' };

describe('delegation wait queue', () => {
  test('waits for slot when queueTimeoutMs > 0 and at capacity', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5, queueTimeoutMs: 5000 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Start first delegation (takes the only slot)
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Second delegation should wait (not be rejected)
    const d2Promise = agent_delegate({ task: 'Task 2' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Release first slot
    resolvers[0]();
    const r1 = await d1;
    expect(r1.response).toBe('done');

    // Second should now acquire the slot and run
    await new Promise(r => setTimeout(r, 10));
    resolvers[1]();
    const r2 = await d2Promise;
    expect(r2.response).toBe('done');
  });

  test('times out when no slot frees within queueTimeoutMs', async () => {
    const providers = mockProviders();

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5, queueTimeoutMs: 50 },
      onDelegate: async () => {
        // Never resolves
        return new Promise<string>(() => {});
      },
    });

    // Take the only slot
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Second should wait and then timeout
    const r2 = await agent_delegate({ task: 'Task 2' }, defaultCtx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('timeout');
  });

  test('legacy behavior: immediate reject when queueTimeoutMs = 0', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5, queueTimeoutMs: 0 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Take the only slot
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Second should be rejected immediately (not queued)
    const r2 = await agent_delegate({ task: 'Task 2' }, defaultCtx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('Max concurrent');

    resolvers[0]();
    await d1;
  });

  test('default behavior (no queueTimeoutMs): immediate reject', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    const r2 = await agent_delegate({ task: 'Task 2' }, defaultCtx);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('Max concurrent');

    resolvers[0]();
    await d1;
  });

  test('FIFO ordering: waiters are processed in order', async () => {
    const providers = mockProviders();
    const resolvers: (() => void)[] = [];
    const completionOrder: string[] = [];

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5, queueTimeoutMs: 5000 },
      onDelegate: async () => {
        return new Promise<string>(resolve => {
          resolvers.push(() => resolve('done'));
        });
      },
    });

    // Take the slot
    const d1 = agent_delegate({ task: 'Task 1' }, defaultCtx);
    await new Promise(r => setTimeout(r, 10));

    // Queue two waiters
    const d2Promise = agent_delegate({ task: 'Task 2' }, defaultCtx);
    d2Promise.then(() => completionOrder.push('Task 2'));
    const d3Promise = agent_delegate({ task: 'Task 3' }, defaultCtx);
    d3Promise.then(() => completionOrder.push('Task 3'));

    await new Promise(r => setTimeout(r, 10));

    // Release slot → Task 2 should get it first
    resolvers[0]();
    await d1;
    await new Promise(r => setTimeout(r, 20));

    // Release slot → Task 3 should get it next
    resolvers[1]();
    await d2Promise;
    await new Promise(r => setTimeout(r, 20));

    resolvers[2]();
    await d3Promise;

    expect(completionOrder).toEqual(['Task 2', 'Task 3']);
  });

  test('slot released after delegation error still wakes next waiter', async () => {
    const providers = mockProviders();
    let callCount = 0;

    const { agent_delegate } = createDelegationHandlers(providers, {
      delegation: { maxConcurrent: 1, maxDepth: 5, queueTimeoutMs: 5000 },
      onDelegate: async () => {
        callCount++;
        if (callCount === 1) throw new Error('first delegate crashed');
        return 'recovered';
      },
    });

    // First delegation will throw
    const r1 = await agent_delegate({ task: 'Task 1' }, defaultCtx);
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('crashed');

    // Second should succeed (slot freed by error)
    const r2 = await agent_delegate({ task: 'Task 2' }, defaultCtx);
    expect(r2.response).toBe('recovered');
  });
});
