/**
 * Tests for LLM IPC handler event bus emissions,
 * including thinking/reasoning events.
 */
import { describe, it, expect } from 'vitest';
import { createLLMHandlers } from '../../../src/host/ipc-handlers/llm.js';
import { createEventBus, type StreamEvent } from '../../../src/host/event-bus.js';
import type { ProviderRegistry } from '../../../src/types.js';
import type { IPCContext } from '../../../src/host/ipc-server.js';

function mockCtx(): IPCContext {
  return { sessionId: 'test-session', agentId: 'test-agent' };
}

/** Build a minimal ProviderRegistry with a custom LLM chat generator. */
function mockProviders(chatFn: () => AsyncIterable<any>): ProviderRegistry {
  return {
    llm: {
      name: 'mock',
      chat: chatFn,
      async models() { return ['mock-model']; },
    },
    workspace: {
      async mount() { return { paths: {} }; },
      async commit() { return { scopes: {} }; },
      async cleanup() {},
      activeMounts() { return []; },
    },
  } as unknown as ProviderRegistry;
}

describe('LLM handler event emissions', () => {
  it('emits llm.start and llm.done for a basic text response', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'text', content: 'Hello' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 2 } };
    });

    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());

    const types = events.map(e => e.type);
    expect(types).toContain('llm.start');
    expect(types).toContain('llm.chunk');
    expect(types).toContain('llm.done');
  });

  it('emits llm.thinking events for thinking chunks', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'thinking', content: 'Let me reason about this...' };
      yield { type: 'thinking', content: 'The answer involves...' };
      yield { type: 'text', content: 'Here is the answer.' };
      yield { type: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });

    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'think about this' }] }, mockCtx());

    const types = events.map(e => e.type);
    expect(types).toEqual([
      'llm.start',
      'llm.thinking',
      'llm.thinking',
      'llm.chunk',
      'llm.done',
    ]);

    // Verify thinking events carry contentLength
    const thinkingEvents = events.filter(e => e.type === 'llm.thinking');
    expect(thinkingEvents).toHaveLength(2);
    expect(thinkingEvents[0].data.contentLength).toBe('Let me reason about this...'.length);
    expect(thinkingEvents[1].data.contentLength).toBe('The answer involves...'.length);
  });

  it('emits tool.call events for tool_use chunks', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'tool_use', toolCall: { id: 't1', name: 'search', args: { q: 'test' } } };
      yield { type: 'done', usage: { inputTokens: 8, outputTokens: 3 } };
    });

    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'search' }] }, mockCtx());

    const toolEvents = events.filter(e => e.type === 'tool.call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].data.toolId).toBe('t1');
    expect(toolEvents[0].data.toolName).toBe('search');
    expect(toolEvents[0].data.args).toEqual({ q: 'test' });
  });

  it('does not emit events when no eventBus is provided', async () => {
    // Should not throw — eventBus is optional
    const providers = mockProviders(async function* () {
      yield { type: 'thinking', content: 'reasoning...' };
      yield { type: 'text', content: 'done' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const handlers = createLLMHandlers(providers);
    const result = await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());
    expect(result.chunks).toHaveLength(3);
  });

  it('includes token usage in llm.done event', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'text', content: 'Answer' };
      yield { type: 'done', usage: { inputTokens: 100, outputTokens: 50 } };
    });

    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());

    const doneEvent = events.find(e => e.type === 'llm.done');
    expect(doneEvent).toBeDefined();
    expect(doneEvent!.data.inputTokens).toBe(100);
    expect(doneEvent!.data.outputTokens).toBe(50);
  });

  it('uses sessionId as requestId for events', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'thinking', content: 'hmm' };
      yield { type: 'text', content: 'ok' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const ctx = { sessionId: 'chatcmpl-abc', agentId: 'agent-1' };
    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, ctx);

    for (const event of events) {
      expect(event.requestId).toBe('chatcmpl-abc');
    }
  });

  it('includes text content in llm.chunk events', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'text', content: 'Hello world' };
      yield { type: 'text', content: '!' };
      yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
    });

    const handlers = createLLMHandlers(providers, undefined, undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());

    const chunkEvents = events.filter(e => e.type === 'llm.chunk');
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents[0].data.content).toBe('Hello world');
    expect(chunkEvents[0].data.contentLength).toBe(11);
    expect(chunkEvents[1].data.content).toBe('!');
    expect(chunkEvents[1].data.contentLength).toBe(1);
  });

  it('uses req.model over configModel when both are present', async () => {
    let calledModel: string | undefined;
    const providers = {
      llm: {
        name: 'mock',
        async *chat(opts: any) {
          calledModel = opts.model;
          yield { type: 'text', content: 'ok' };
          yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async models() { return ['mock-model']; },
      },
      workspace: {
        async mount() { return { paths: {} }; },
        async commit() { return { scopes: {} }; },
        async cleanup() {},
        activeMounts() { return []; },
      },
    } as unknown as ProviderRegistry;

    const handlers = createLLMHandlers(providers, 'config-default-model');
    await handlers.llm_call({ model: 'override-model', messages: [{ role: 'user', content: 'hi' }] }, mockCtx());
    expect(calledModel).toBe('override-model');
  });

  it('falls back to configModel when req.model is absent', async () => {
    let calledModel: string | undefined;
    const providers = {
      llm: {
        name: 'mock',
        async *chat(opts: any) {
          calledModel = opts.model;
          yield { type: 'text', content: 'ok' };
          yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async models() { return ['mock-model']; },
      },
      workspace: {
        async mount() { return { paths: {} }; },
        async commit() { return { scopes: {} }; },
        async cleanup() {},
        activeMounts() { return []; },
      },
    } as unknown as ProviderRegistry;

    const handlers = createLLMHandlers(providers, 'config-default-model');
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());
    expect(calledModel).toBe('config-default-model');
  });

  it('includes context metrics in llm.start event', async () => {
    const eventBus = createEventBus();
    const events: StreamEvent[] = [];
    eventBus.subscribe((e) => events.push(e));

    const providers = mockProviders(async function* () {
      yield { type: 'text', content: 'ok' };
      yield { type: 'done', usage: { inputTokens: 5, outputTokens: 2 } };
    });

    const handlers = createLLMHandlers(providers, 'claude-sonnet-4-20250514', undefined, eventBus);
    await handlers.llm_call({ messages: [{ role: 'user', content: 'hi' }] }, mockCtx());

    const startEvent = events.find(e => e.type === 'llm.start');
    expect(startEvent).toBeDefined();
    expect(startEvent!.data.contextWindow).toBe(200_000);
    expect(startEvent!.data.estimatedInputTokens).toBeGreaterThan(0);
    expect(startEvent!.data.contextRemaining).toBeGreaterThan(0);
    expect(startEvent!.data.contextRemaining).toBeLessThanOrEqual(100);
  });

});
