import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createIPCHandler, type IPCContext, type DelegateRequest } from '../../src/host/ipc-server.js';
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

describe('agent_delegate IPC action', () => {
  test('delegates task to secondary agent', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'delegation result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    const result = await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Summarize this document' }),
      defaultCtx,
    );
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBe('delegation result');
    expect(onDelegate).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'Summarize this document' }),
      expect.objectContaining({ sessionId: 'test-session' }),
    );
  });

  test('rejects when max concurrent delegations reached', async () => {
    const providers = mockProviders();
    let resolveDelegate: (() => void) | null = null;
    const onDelegate = vi.fn(
      () => new Promise<string>(resolve => {
        resolveDelegate = () => resolve('done');
      }),
    );

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate,
    });

    // Start first delegation (won't resolve yet)
    const first = handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Task 1' }),
      defaultCtx,
    );

    // Second delegation should be rejected (max concurrent = 1)
    const secondResult = await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Task 2' }),
      defaultCtx,
    );
    const secondParsed = JSON.parse(secondResult);
    expect(secondParsed.ok).toBe(false);
    expect(secondParsed.error).toContain('Max concurrent');

    // Clean up — resolve the first delegation
    resolveDelegate!();
    await first;
  });

  test('rejects when max depth exceeded', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'deep result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    // Simulate a depth=2 agent trying to delegate further
    const deepCtx: IPCContext = {
      sessionId: 'test-session',
      agentId: 'delegate-primary:depth=2',
    };

    const result = await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Too deep' }),
      deepCtx,
    );
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Max delegation depth');
    expect(onDelegate).not.toHaveBeenCalled();
  });

  test('returns error when delegation not configured', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      // No onDelegate callback
    });

    const result = await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'No handler' }),
      defaultCtx,
    );
    const parsed = JSON.parse(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('not configured');
  });

  test('passes context and fields to delegate handler', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    await handler(
      JSON.stringify({
        action: 'agent_delegate',
        task: 'Do something',
        context: 'Some background context',
      }),
      defaultCtx,
    );

    expect(onDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Do something',
        context: 'Some background context',
      }),
      expect.objectContaining({
        agentId: expect.stringContaining('depth=1'),
      }),
    );
  });

  test('passes runner and model to delegate handler', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    await handler(
      JSON.stringify({
        action: 'agent_delegate',
        task: 'Code review',
        runner: 'claude-code',
        model: 'claude-sonnet-4-5-20250929',
      }),
      defaultCtx,
    );

    expect(onDelegate).toHaveBeenCalledWith(
      expect.objectContaining({
        task: 'Code review',
        runner: 'claude-code',
        model: 'claude-sonnet-4-5-20250929',
      }),
      expect.objectContaining({ sessionId: 'test-session' }),
    );
  });

  test('audit logs runner and model when provided', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    await handler(
      JSON.stringify({
        action: 'agent_delegate',
        task: 'Research task',
        runner: 'pi-coding-agent',
        model: 'claude-sonnet-4-5-20250929',
      }),
      defaultCtx,
    );

    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_delegate',
        args: expect.objectContaining({
          depth: 1,
          runner: 'pi-coding-agent',
          model: 'claude-sonnet-4-5-20250929',
        }),
      }),
    );
  });

  test('decrements active count after delegation completes', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'done');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate,
    });

    // First delegation completes
    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Task 1' }),
      defaultCtx,
    );

    // Second delegation should succeed (first completed)
    const result = await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Task 2' }),
      defaultCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBe('done');
  });

  test('decrements active count even on error', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => { throw new Error('delegate failed'); });

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate,
    });

    // First delegation fails
    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Will fail' }),
      defaultCtx,
    );

    // Second delegation should still succeed (active count decremented)
    const onDelegate2 = vi.fn(async () => 'recovered');
    const handler2 = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 1, maxDepth: 2 },
      onDelegate: onDelegate2,
    });

    const result = await handler2(
      JSON.stringify({ action: 'agent_delegate', task: 'Task 2' }),
      defaultCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBe('recovered');
  });

  test('audit logs delegation events', async () => {
    const providers = mockProviders();
    const onDelegate = vi.fn(async () => 'result');

    const handler = createIPCHandler(providers, {
      agentId: 'test-agent',
      delegation: { maxConcurrent: 3, maxDepth: 2 },
      onDelegate,
    });

    await handler(
      JSON.stringify({ action: 'agent_delegate', task: 'Audit this task' }),
      defaultCtx,
    );

    // Should have audit log calls for the delegation
    expect(providers.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'agent_delegate',
        sessionId: 'test-session',
        args: expect.objectContaining({ depth: 1 }),
      }),
    );
  });

  test('validates schema (rejects invalid requests)', async () => {
    const providers = mockProviders();
    const handler = createIPCHandler(providers, { agentId: 'test-agent' });

    // Missing required 'task' field
    const result = await handler(
      JSON.stringify({ action: 'agent_delegate' }),
      defaultCtx,
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Validation failed');
  });
});
