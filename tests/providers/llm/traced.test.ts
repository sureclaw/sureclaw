import { describe, test, expect, vi, beforeEach } from 'vitest';
import { TracedLLMProvider } from '../../../src/providers/llm/traced.js';
import type { LLMProvider, ChatRequest, ChatChunk } from '../../../src/providers/llm/types.js';
import type { Tracer, Span } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(chunks: ChatChunk[]): LLMProvider {
  return {
    name: 'mock-inner',
    async *chat(_req: ChatRequest) {
      for (const c of chunks) yield c;
    },
    async models() { return ['mock-model']; },
  };
}

function makeMockSpan(): Span & {
  _attributes: Record<string, unknown>;
  _events: { name: string; attributes?: Record<string, unknown> }[];
  _ended: boolean;
  _exception: Error | null;
  _status: { code: number; message?: string } | null;
} {
  const span = {
    _attributes: {} as Record<string, unknown>,
    _events: [] as { name: string; attributes?: Record<string, unknown> }[],
    _ended: false,
    _exception: null as Error | null,
    _status: null as { code: number; message?: string } | null,
    setAttribute(key: string, value: unknown) { span._attributes[key] = value; return span; },
    setAttributes(attrs: Record<string, unknown>) { Object.assign(span._attributes, attrs); return span; },
    addEvent(name: string, attributes?: Record<string, unknown>) { span._events.push({ name, attributes }); return span; },
    setStatus(status: { code: number; message?: string }) { span._status = status; return span; },
    recordException(err: Error) { span._exception = err; },
    end() { span._ended = true; },
    spanContext() { return { traceId: '0', spanId: '0', traceFlags: 0 }; },
    isRecording() { return true; },
    updateName() { return span; },
  };
  return span as typeof span;
}

function makeMockTracer(span: Span): Tracer {
  return {
    startSpan: vi.fn().mockReturnValue(span),
    startActiveSpan: vi.fn(),
  } as unknown as Tracer;
}

async function collectChunks(iter: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const result: ChatChunk[] = [];
  for await (const chunk of iter) result.push(chunk);
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TracedLLMProvider', () => {
  const baseReq: ChatRequest = {
    model: 'test-model',
    messages: [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ],
  };

  let mockSpan: ReturnType<typeof makeMockSpan>;
  let mockTracer: Tracer;

  beforeEach(() => {
    mockSpan = makeMockSpan();
    mockTracer = makeMockTracer(mockSpan);
  });

  test('yields all chunks from inner provider unchanged', async () => {
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'Hi there' },
      { type: 'done', usage: { inputTokens: 5, outputTokens: 2 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    const result = await collectChunks(provider.chat(baseReq));
    expect(result).toEqual(chunks);
  });

  test('creates span with correct start attributes', async () => {
    const req: ChatRequest = {
      ...baseReq,
      maxTokens: 1024,
      tools: [
        { name: 'search', description: 'Search the web', parameters: {} },
        { name: 'read', description: 'Read a file', parameters: {} },
      ],
    };
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'ok' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(req));

    expect(mockTracer.startSpan).toHaveBeenCalledWith('gen_ai.chat', {
      attributes: expect.objectContaining({
        'gen_ai.system': 'mock-inner',
        'gen_ai.request.model': 'test-model',
        'gen_ai.request.max_tokens': 1024,
        'gen_ai.tool.count': 2,
      }),
    });
  });

  test('records each input message as a span event', async () => {
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'ok' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(baseReq));

    const messageEvents = mockSpan._events.filter(e =>
      e.name.startsWith('gen_ai.') && e.name.endsWith('.message') && e.name !== 'gen_ai.assistant.message',
    );
    expect(messageEvents).toHaveLength(2);
    expect(messageEvents[0]).toEqual({
      name: 'gen_ai.system.message',
      attributes: { content: 'You are helpful.' },
    });
    expect(messageEvents[1]).toEqual({
      name: 'gen_ai.user.message',
      attributes: { content: 'Hello' },
    });
  });

  test('records tool_use chunks as span events', async () => {
    const chunks: ChatChunk[] = [
      { type: 'tool_use', toolCall: { id: 'tc1', name: 'search', args: { q: 'test' } } },
      { type: 'done', usage: { inputTokens: 5, outputTokens: 3 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(baseReq));

    const toolEvents = mockSpan._events.filter(e => e.name === 'gen_ai.tool.call');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]!.attributes).toEqual({
      name: 'search',
      args: JSON.stringify({ q: 'test' }),
    });
    expect(mockSpan._attributes['gen_ai.response.tool_call_count']).toBe(1);
  });

  test('sets usage attributes from done chunk', async () => {
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'response' },
      { type: 'done', usage: { inputTokens: 42, outputTokens: 17 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(baseReq));

    expect(mockSpan._attributes['gen_ai.usage.input_tokens']).toBe(42);
    expect(mockSpan._attributes['gen_ai.usage.output_tokens']).toBe(17);
  });

  test('records exception on error and re-throws', async () => {
    const error = new Error('LLM failed');
    const failProvider: LLMProvider = {
      name: 'fail',
      async *chat() { throw error; },
      async models() { return []; },
    };
    const provider = new TracedLLMProvider(failProvider, mockTracer);

    await expect(collectChunks(provider.chat(baseReq))).rejects.toThrow('LLM failed');
    expect(mockSpan._exception).toBe(error);
    expect(mockSpan._status).toEqual({ code: SpanStatusCode.ERROR, message: 'LLM failed' });
    expect(mockSpan._ended).toBe(true);
  });

  test('ends span even on success', async () => {
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'ok' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(baseReq));
    expect(mockSpan._ended).toBe(true);
  });

  test('works correctly with no-op tracer (no overhead)', async () => {
    // The OTel API returns no-op tracers/spans when SDK is not registered.
    // Simulate by using a tracer that returns a minimal no-op span.
    const noopSpan: Span = {
      setAttribute: () => noopSpan,
      setAttributes: () => noopSpan,
      addEvent: () => noopSpan,
      setStatus: () => noopSpan,
      recordException: () => {},
      end: () => {},
      spanContext: () => ({ traceId: '0', spanId: '0', traceFlags: 0 }),
      isRecording: () => false,
      updateName: () => noopSpan,
    } as unknown as Span;
    const noopTracer: Tracer = {
      startSpan: () => noopSpan,
      startActiveSpan: vi.fn(),
    } as unknown as Tracer;

    const chunks: ChatChunk[] = [
      { type: 'text', content: 'Hello' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), noopTracer);
    const result = await collectChunks(provider.chat(baseReq));
    expect(result).toEqual(chunks);
  });

  test('delegates models() to inner provider', async () => {
    const inner = makeMockProvider([]);
    const provider = new TracedLLMProvider(inner, mockTracer);
    const models = await provider.models();
    expect(models).toEqual(['mock-model']);
  });

  test('exposes inner provider name', () => {
    const inner = makeMockProvider([]);
    const provider = new TracedLLMProvider(inner, mockTracer);
    expect(provider.name).toBe('mock-inner');
  });

  test('stringifies content block arrays in message events', async () => {
    const req: ChatRequest = {
      model: 'test-model',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      ],
    };
    const chunks: ChatChunk[] = [
      { type: 'text', content: 'ok' },
      { type: 'done', usage: { inputTokens: 1, outputTokens: 1 } },
    ];
    const provider = new TracedLLMProvider(makeMockProvider(chunks), mockTracer);
    await collectChunks(provider.chat(req));

    const msgEvents = mockSpan._events.filter(e => e.name === 'gen_ai.user.message');
    expect(msgEvents).toHaveLength(1);
    expect(msgEvents[0]!.attributes!.content).toBe(JSON.stringify([{ type: 'text', text: 'Hello' }]));
  });
});
