import { describe, test, expect, vi } from 'vitest';
import { AxChatTransport, type Diagnostic, type StatusEvent } from './ax-chat-transport';

/**
 * Build a ReadableStream<Uint8Array> from a string body. Mirrors how fetch
 * returns response bodies, letting us exercise processResponseStream directly.
 */
function sseStream(body: string, { chunkSize }: { chunkSize?: number } = {}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body);
  if (!chunkSize || chunkSize >= bytes.length) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

/** Drain a UIMessageChunk stream so the transform pipeline runs to completion. */
async function drain(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const reader = stream.getReader();
  const chunks: unknown[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return chunks;
}

/**
 * processResponseStream is protected; cast to a call-signature shape to invoke
 * it in tests without subclassing boilerplate.
 */
type StreamFn = (s: ReadableStream<Uint8Array>) => ReadableStream<unknown>;
const asProcess = (t: AxChatTransport): StreamFn =>
  (t as unknown as { processResponseStream: StreamFn }).processResponseStream.bind(t);

describe('AxChatTransport diagnostic event parsing', () => {
  test('parses a single diagnostic event and invokes onDiagnostic with payload', async () => {
    const onDiagnostic = vi.fn();
    const transport = new AxChatTransport({ onDiagnostic });
    const diagnostic: Diagnostic = {
      severity: 'warn',
      kind: 'catalog_populate_openapi_source_failed',
      message: 'Skill "petstore" failed to load OpenAPI spec',
      context: { skill: 'petstore', source: 'https://example.com/spec.json' },
      timestamp: '2026-04-21T18:30:00.000Z',
    };
    const body =
      `event: diagnostic\ndata: ${JSON.stringify(diagnostic)}\n\n` +
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    await drain(asProcess(transport)(sseStream(body)));

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });

  test('invokes onDiagnostic once per event when multiple diagnostics arrive in one stream', async () => {
    const received: Diagnostic[] = [];
    const onDiagnostic = (d: Diagnostic) => { received.push(d); };
    const transport = new AxChatTransport({ onDiagnostic });
    const d1: Diagnostic = { severity: 'warn', kind: 'catalog_populate_openapi_source_failed', message: 'first', timestamp: '2026-04-21T18:30:00.000Z' };
    const d2: Diagnostic = { severity: 'error', kind: 'catalog_populate_server_failed', message: 'second', timestamp: '2026-04-21T18:30:01.000Z' };
    const d3: Diagnostic = { severity: 'info', kind: 'diagnostic_overflow', message: 'third', timestamp: '2026-04-21T18:30:02.000Z' };
    const body =
      `event: diagnostic\ndata: ${JSON.stringify(d1)}\n\n` +
      `event: diagnostic\ndata: ${JSON.stringify(d2)}\n\n` +
      `event: diagnostic\ndata: ${JSON.stringify(d3)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    await drain(asProcess(transport)(sseStream(body)));

    expect(received).toEqual([d1, d2, d3]);
  });

  test('never invokes onDiagnostic on a clean turn with zero diagnostic events', async () => {
    const onDiagnostic = vi.fn();
    const transport = new AxChatTransport({ onDiagnostic });
    const body =
      `data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    await drain(asProcess(transport)(sseStream(body)));

    expect(onDiagnostic).not.toHaveBeenCalled();
  });

  test('malformed diagnostic JSON is skipped without crashing the stream', async () => {
    const onDiagnostic = vi.fn();
    const onStatus = vi.fn((_: StatusEvent) => {});
    const transport = new AxChatTransport({ onDiagnostic, onStatus });
    const body =
      `event: diagnostic\ndata: {not valid json\n\n` +
      `event: status\ndata: {"operation":"test","phase":"go","message":"ok"}\n\n` +
      `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    const chunks = await drain(asProcess(transport)(sseStream(body)));

    // Malformed diagnostic is dropped
    expect(onDiagnostic).not.toHaveBeenCalled();
    // Stream kept flowing — subsequent status event was parsed (the clear-status
    // synthesized on first content arrival is also delivered, so >= 1)
    expect(onStatus).toHaveBeenCalled();
    expect(onStatus.mock.calls.some(([ev]) => ev?.operation === 'test' && ev?.message === 'ok')).toBe(true);
    // And text content made it through to UIMessageChunks
    const textDeltas = chunks.filter((c): c is { type: string; delta: string } =>
      typeof c === 'object' && c !== null && (c as { type: string }).type === 'text-delta');
    expect(textDeltas.some((c) => c.delta === 'hi')).toBe(true);
  });

  test('survives SSE frames split across decoder chunks', async () => {
    const onDiagnostic = vi.fn();
    const transport = new AxChatTransport({ onDiagnostic });
    const diagnostic: Diagnostic = { severity: 'warn', kind: 'catalog_populate_server_failed', message: 'chunk-split', timestamp: '2026-04-21T18:30:03.000Z' };
    const body =
      `event: diagnostic\ndata: ${JSON.stringify(diagnostic)}\n\n` +
      `data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n` +
      `data: [DONE]\n\n`;

    // chunkSize=7 forces frames to span multiple transform() calls
    await drain(asProcess(transport)(sseStream(body, { chunkSize: 7 })));

    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith(diagnostic);
  });
});
