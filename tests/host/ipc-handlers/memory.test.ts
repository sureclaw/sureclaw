// tests/host/ipc-handlers/memory.test.ts — Server-side userId injection tests
import { describe, it, expect, vi } from 'vitest';
import { createMemoryHandlers } from '../../../src/host/ipc-handlers/memory.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { MemoryProvider, MemoryEntry, MemoryQuery } from '../../../src/providers/memory/types.js';

function createSpyMemory() {
  const writeCalls: MemoryEntry[] = [];
  const queryCalls: MemoryQuery[] = [];
  const listCalls: Array<{ scope: string; limit?: number; userId?: string }> = [];

  const memory: MemoryProvider = {
    async write(entry: MemoryEntry) {
      writeCalls.push(entry);
      return 'mem-id-1';
    },
    async query(q: MemoryQuery) {
      queryCalls.push(q);
      return [];
    },
    async read() { return null; },
    async delete() {},
    async list(scope: string, limit?: number, userId?: string) {
      listCalls.push({ scope, limit, userId });
      return [];
    },
  };

  return { memory, writeCalls, queryCalls, listCalls };
}

function stubProviders(memory: MemoryProvider): ProviderRegistry {
  return {
    memory,
    audit: { log: vi.fn() },
  } as any;
}

describe('memory IPC handlers — userId injection', () => {
  it('DM context injects ctx.userId into write', async () => {
    const { memory, writeCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_write({ scope: 'default', content: 'Hello' }, ctx);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].userId).toBe('alice');
  });

  it('channel context omits userId from write (shared)', async () => {
    const { memory, writeCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'channel' };
    await handlers.memory_write({ scope: 'default', content: 'Channel fact' }, ctx);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].userId).toBeUndefined();
  });

  it('undefined sessionScope defaults to DM behavior (injects userId)', async () => {
    const { memory, writeCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice' };
    await handlers.memory_write({ scope: 'default', content: 'Hello' }, ctx);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].userId).toBe('alice');
  });

  it('DM context injects userId into query', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_query({ scope: 'default', query: 'TypeScript' }, ctx);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].userId).toBe('alice');
  });

  it('channel context omits userId from query', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'channel' };
    await handlers.memory_query({ scope: 'default', query: 'TypeScript' }, ctx);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].userId).toBeUndefined();
  });

  it('DM context injects userId into list', async () => {
    const { memory, listCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_list({ scope: 'default', limit: 10 }, ctx);

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].userId).toBe('alice');
  });

  it('channel context omits userId from list', async () => {
    const { memory, listCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'channel' };
    await handlers.memory_list({ scope: 'default', limit: 10 }, ctx);

    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].userId).toBeUndefined();
  });

  it('group context omits userId (agent-scoped)', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'group' };
    await handlers.memory_query({ scope: 'default', query: 'test' }, ctx);

    expect(queryCalls[0].userId).toBeUndefined();
  });

  it('memory_read does not inject userId (ID-based access)', async () => {
    const { memory } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    // memory_read takes req and no ctx userId injection
    const result = await handlers.memory_read({ id: 'some-id' });
    expect(result).toEqual({ entry: null });
  });
});
