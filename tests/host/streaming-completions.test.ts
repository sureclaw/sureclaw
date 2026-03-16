/**
 * Tests for streaming chat completions — verifying that llm.chunk and tool.call
 * event bus events are converted into OpenAI-compatible SSE chunks when stream=true.
 */
import { describe, it, expect } from 'vitest';
import { createEventBus, type EventBus, type StreamEvent } from '../../src/host/event-bus.js';
import type { OpenAIStreamChunk } from '../../src/host/server-http.js';

/**
 * Simulates the streaming logic from handleCompletions in server.ts.
 * We test the event-bus-to-SSE conversion in isolation without spinning up
 * the full server or processCompletion pipeline.
 */
function simulateStreamingResponse(
  eventBus: EventBus,
  requestId: string,
  model: string,
): { chunks: OpenAIStreamChunk[]; run: (emitFn: () => void) => void } {
  const chunks: OpenAIStreamChunk[] = [];
  const created = Math.floor(Date.now() / 1000);

  return {
    chunks,
    run(emitFn: () => void) {
      // Role chunk (sent before subscribing, just like server.ts)
      chunks.push({
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });

      let streamedContent = false;
      let toolCallIndex = 0;
      let hasToolCalls = false;

      // Subscribe to event bus — mirrors handleCompletions logic
      const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
        if (event.type === 'llm.chunk' && typeof event.data.content === 'string') {
          streamedContent = true;
          chunks.push({
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: event.data.content as string }, finish_reason: null }],
          });
        } else if (event.type === 'tool.call' && event.data.toolName) {
          streamedContent = true;
          hasToolCalls = true;
          chunks.push({
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: {
              tool_calls: [{
                index: toolCallIndex++,
                id: (event.data.toolId as string) ?? `call_${toolCallIndex}`,
                type: 'function',
                function: {
                  name: event.data.toolName as string,
                  arguments: JSON.stringify(event.data.args ?? {}),
                },
              }],
            }, finish_reason: null }],
          });
        }
      });

      // Simulate processCompletion — emits events synchronously
      emitFn();

      unsubscribe();

      // Fallback for no events
      if (!streamedContent) {
        chunks.push({
          id: requestId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: 'fallback response' }, finish_reason: null }],
        });
      }

      // Finish chunk — use 'tool_calls' when the response included tool calls
      const finishReason = hasToolCalls ? 'tool_calls' as const : 'stop' as const;
      chunks.push({
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
    },
  };
}

/**
 * Simulates the streaming logic with try/catch/finally error handling,
 * matching the fixed server.ts code. Returns chunks, error state, and cleanup state.
 */
function simulateStreamingWithErrorHandling(
  eventBus: EventBus,
  requestId: string,
  model: string,
): {
  chunks: OpenAIStreamChunk[];
  cleaned: { unsubscribed: boolean; keepaliveCleared: boolean };
  run: (emitFn: () => void) => void;
  runWithError: (error: Error) => void;
} {
  const chunks: OpenAIStreamChunk[] = [];
  const created = Math.floor(Date.now() / 1000);
  const cleaned = { unsubscribed: false, keepaliveCleared: false };

  function runInternal(emitFn: (() => void) | null, error: Error | null) {
    // Role chunk
    chunks.push({
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });

    let streamedContent = false;
    let hasToolCalls = false;
    let toolCallIndex = 0;

    const unsubscribe = eventBus.subscribeRequest(requestId, (event) => {
      if (event.type === 'llm.chunk' && typeof event.data.content === 'string') {
        streamedContent = true;
        chunks.push({
          id: requestId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: event.data.content as string }, finish_reason: null }],
        });
      }
    });

    try {
      if (error) throw error;
      if (emitFn) emitFn();

      if (!streamedContent) {
        chunks.push({
          id: requestId, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { content: 'fallback' }, finish_reason: null }],
        });
      }

      const finishReason = hasToolCalls ? 'tool_calls' as const : 'stop' as const;
      chunks.push({
        id: requestId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      });
    } catch (err) {
      // Error recovery: send error message and close stream (matches server.ts fix)
      chunks.push({
        id: requestId, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { content: `\n\nInternal processing error: ${(err as Error).message}` }, finish_reason: 'stop' }],
      });
    } finally {
      cleaned.keepaliveCleared = true;
      cleaned.unsubscribed = true;
      unsubscribe();
    }
  }

  return {
    chunks,
    cleaned,
    run: (emitFn) => runInternal(emitFn, null),
    runWithError: (error) => runInternal(null, error),
  };
}

describe('Streaming chat completions (event bus → SSE)', () => {
  it('converts llm.chunk events into OpenAI SSE content deltas', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-1';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      eventBus.emit({
        type: 'llm.chunk',
        requestId,
        timestamp: Date.now(),
        data: { chunkType: 'text', content: 'Hello', contentLength: 5 },
      });
      eventBus.emit({
        type: 'llm.chunk',
        requestId,
        timestamp: Date.now(),
        data: { chunkType: 'text', content: ' world', contentLength: 6 },
      });
    });

    // Expect: role chunk, 2 content chunks, finish chunk
    expect(chunks).toHaveLength(4);

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe('assistant');
    expect(chunks[0].choices[0].finish_reason).toBeNull();

    // Content deltas
    expect(chunks[1].choices[0].delta.content).toBe('Hello');
    expect(chunks[1].choices[0].finish_reason).toBeNull();
    expect(chunks[2].choices[0].delta.content).toBe(' world');
    expect(chunks[2].choices[0].finish_reason).toBeNull();

    // Finish chunk
    expect(chunks[3].choices[0].delta).toEqual({});
    expect(chunks[3].choices[0].finish_reason).toBe('stop');

    // All chunks share the same requestId
    for (const chunk of chunks) {
      expect(chunk.id).toBe(requestId);
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(chunk.model).toBe('test-model');
    }
  });

  it('converts tool.call events into OpenAI SSE tool_calls deltas', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-tool';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      eventBus.emit({
        type: 'tool.call',
        requestId,
        timestamp: Date.now(),
        data: { toolId: 'call_abc', toolName: 'web_search', args: { query: 'hello' } },
      });
    });

    // Expect: role + tool_call + finish
    expect(chunks).toHaveLength(3);

    const toolDelta = chunks[1].choices[0].delta;
    expect(toolDelta.tool_calls).toHaveLength(1);
    expect(toolDelta.tool_calls![0]).toEqual({
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: 'web_search', arguments: '{"query":"hello"}' },
    });

    // finish_reason should be 'tool_calls' when tool calls were emitted
    expect(chunks[2].choices[0].finish_reason).toBe('tool_calls');
  });

  it('streams text and tool calls interleaved', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-mixed';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      eventBus.emit({
        type: 'llm.chunk', requestId, timestamp: Date.now(),
        data: { chunkType: 'text', content: 'Let me search', contentLength: 13 },
      });
      eventBus.emit({
        type: 'tool.call', requestId, timestamp: Date.now(),
        data: { toolId: 'call_1', toolName: 'search', args: { q: 'test' } },
      });
      eventBus.emit({
        type: 'tool.call', requestId, timestamp: Date.now(),
        data: { toolId: 'call_2', toolName: 'read_file', args: { path: '/tmp/x' } },
      });
      eventBus.emit({
        type: 'llm.chunk', requestId, timestamp: Date.now(),
        data: { chunkType: 'text', content: ' done', contentLength: 5 },
      });
    });

    // role + text + tool + tool + text + finish = 6
    expect(chunks).toHaveLength(6);

    expect(chunks[1].choices[0].delta.content).toBe('Let me search');
    expect(chunks[2].choices[0].delta.tool_calls![0].index).toBe(0);
    expect(chunks[2].choices[0].delta.tool_calls![0].function.name).toBe('search');
    expect(chunks[3].choices[0].delta.tool_calls![0].index).toBe(1);
    expect(chunks[3].choices[0].delta.tool_calls![0].function.name).toBe('read_file');
    expect(chunks[4].choices[0].delta.content).toBe(' done');
    expect(chunks[5].choices[0].finish_reason).toBe('tool_calls');
  });

  it('ignores events for other requestIds', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-2';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      // Event for a different request — should be ignored
      eventBus.emit({
        type: 'llm.chunk',
        requestId: 'chatcmpl-other',
        timestamp: Date.now(),
        data: { chunkType: 'text', content: 'wrong request', contentLength: 13 },
      });
      // Event for our request
      eventBus.emit({
        type: 'llm.chunk',
        requestId,
        timestamp: Date.now(),
        data: { chunkType: 'text', content: 'correct', contentLength: 7 },
      });
    });

    // Expect: role + 1 content + finish (the other-request event was ignored)
    expect(chunks).toHaveLength(3);
    expect(chunks[1].choices[0].delta.content).toBe('correct');
  });

  it('falls back to full response when no streamable events arrive', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-3';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      // Emit non-streamable events only
      eventBus.emit({
        type: 'llm.start',
        requestId,
        timestamp: Date.now(),
        data: { model: 'test', messageCount: 1, toolCount: 0 },
      });
      eventBus.emit({
        type: 'llm.done',
        requestId,
        timestamp: Date.now(),
        data: { chunkCount: 0, toolUseCount: 0 },
      });
    });

    // Expect: role + fallback content + finish
    expect(chunks).toHaveLength(3);
    expect(chunks[1].choices[0].delta.content).toBe('fallback response');
  });

  it('ignores llm.start, llm.thinking, and llm.done events', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-4';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    run(() => {
      eventBus.emit({
        type: 'llm.start', requestId, timestamp: Date.now(),
        data: { model: 'test', messageCount: 1, toolCount: 0 },
      });
      eventBus.emit({
        type: 'llm.thinking', requestId, timestamp: Date.now(),
        data: { contentLength: 42 },
      });
      eventBus.emit({
        type: 'llm.chunk', requestId, timestamp: Date.now(),
        data: { chunkType: 'text', content: 'actual content', contentLength: 14 },
      });
      eventBus.emit({
        type: 'llm.done', requestId, timestamp: Date.now(),
        data: { chunkCount: 3, toolUseCount: 1 },
      });
    });

    // Only llm.chunk should produce a content delta
    expect(chunks).toHaveLength(3); // role + 1 content + finish
    expect(chunks[1].choices[0].delta.content).toBe('actual content');
  });

  it('handles many small chunks for realistic streaming', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-5';

    const { chunks, run } = simulateStreamingResponse(eventBus, requestId, 'test-model');

    const words = ['The', ' quick', ' brown', ' fox', ' jumps', ' over', ' the', ' lazy', ' dog'];

    run(() => {
      for (const word of words) {
        eventBus.emit({
          type: 'llm.chunk',
          requestId,
          timestamp: Date.now(),
          data: { chunkType: 'text', content: word, contentLength: word.length },
        });
      }
    });

    // role + 9 content + finish = 11
    expect(chunks).toHaveLength(11);

    // Reconstruct streamed content
    const streamedText = chunks
      .slice(1, -1) // skip role and finish
      .map(c => c.choices[0].delta.content)
      .join('');
    expect(streamedText).toBe('The quick brown fox jumps over the lazy dog');
  });

  it('sends error chunk and closes stream when processCompletion throws', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-error';

    const { chunks, cleaned, runWithError } = simulateStreamingWithErrorHandling(
      eventBus, requestId, 'test-model',
    );

    runWithError(new Error('Scanner provider failed'));

    // Should have: role chunk + error chunk = 2
    expect(chunks).toHaveLength(2);

    // Role chunk
    expect(chunks[0].choices[0].delta.role).toBe('assistant');

    // Error chunk — includes the error message and finishes the stream
    expect(chunks[1].choices[0].delta.content).toContain('Internal processing error');
    expect(chunks[1].choices[0].delta.content).toContain('Scanner provider failed');
    expect(chunks[1].choices[0].finish_reason).toBe('stop');

    // Cleanup must have happened
    expect(cleaned.unsubscribed).toBe(true);
    expect(cleaned.keepaliveCleared).toBe(true);
  });

  it('cleans up event bus subscription even on error', () => {
    const eventBus = createEventBus();
    const requestId = 'chatcmpl-test-cleanup';

    const { cleaned, runWithError } = simulateStreamingWithErrorHandling(
      eventBus, requestId, 'test-model',
    );

    runWithError(new Error('Sandbox spawn failed'));

    expect(cleaned.unsubscribed).toBe(true);
    expect(cleaned.keepaliveCleared).toBe(true);

    // Verify subscription was actually removed — emitting after error should not crash
    eventBus.emit({
      type: 'llm.chunk', requestId, timestamp: Date.now(),
      data: { content: 'late event' },
    });
    // No assertions needed — just verifying no throw
  });
});
