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

  it('DM context injects userId into query (default pool=both makes 2 calls)', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_query({ scope: 'default', query: 'TypeScript' }, ctx);

    // Default pool='both' makes two calls: agent + company
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].userId).toBe('alice');
    expect(queryCalls[1].scope).toBe('company');
  });

  it('channel context omits userId from query (default pool=both)', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'main', userId: 'alice', sessionScope: 'channel' };
    await handlers.memory_query({ scope: 'default', query: 'TypeScript' }, ctx);

    // Default pool='both' makes two calls: agent + company
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].userId).toBeUndefined();
    expect(queryCalls[1].scope).toBe('company');
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

  it('memory_query with pool=both searches agent and company scopes', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_query({ scope: 'knowledge', query: 'test', pool: 'both' }, ctx);

    // Should have been called twice: once for agent scope (with userId), once for company
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].userId).toBe('alice');
    expect(queryCalls[1].scope).toBe('company');
    expect(queryCalls[1].userId).toBeUndefined();
  });

  it('memory_query with pool=company only queries company scope', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_query({ scope: 'knowledge', query: 'test', pool: 'company' }, ctx);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].scope).toBe('company');
    expect(queryCalls[0].userId).toBeUndefined();
  });

  it('memory_query with pool=agent only queries agent scope', async () => {
    const { memory, queryCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_query({ scope: 'knowledge', query: 'test', pool: 'agent' }, ctx);

    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].userId).toBe('alice');
    expect(queryCalls[0].scope).toBe('knowledge');
  });

  it('memory_write with pool=company writes to company scope', async () => {
    const { memory, writeCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_write({ scope: 'knowledge', content: 'shared fact', pool: 'company' }, ctx);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].scope).toBe('company');
    expect(writeCalls[0].userId).toBeUndefined();
  });

  it('memory_write without pool writes to agent scope (default)', async () => {
    const { memory, writeCalls } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    const ctx: IPCContext = { sessionId: 's1', agentId: 'my-agent', userId: 'alice', sessionScope: 'dm' };
    await handlers.memory_write({ scope: 'knowledge', content: 'personal fact' }, ctx);

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].scope).toBe('knowledge');
    expect(writeCalls[0].userId).toBe('alice');
  });

  it('memory_read does not inject userId (ID-based access)', async () => {
    const { memory } = createSpyMemory();
    const handlers = createMemoryHandlers(stubProviders(memory));

    // memory_read takes req and no ctx userId injection
    const result = await handlers.memory_read({ id: 'some-id' });
    expect(result).toEqual({ entry: null });
  });
});
