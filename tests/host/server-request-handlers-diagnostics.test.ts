/**
 * Tests the diagnostic SSE + JSON emission contract in
 * `server-request-handlers.ts` — Task B2 of the "surface skill/catalog
 * failures" pipeline. Asserts:
 *
 *   - Streaming mode: per-diagnostic `event: diagnostic\ndata: {...}` frames
 *     land AFTER the final `finish_reason` SSE chunk and BEFORE `data: [DONE]`.
 *   - Non-streaming mode: diagnostics appear as a top-level `diagnostics`
 *     field on the JSON response body.
 *   - Clean turn (empty/absent diagnostics): zero diagnostic SSE events,
 *     and the JSON body omits the `diagnostics` field entirely.
 *
 * The B3 chat UI (next task) will parse `event: diagnostic` frames and
 * render a banner; this test locks the wire shape the UI will rely on.
 */

import { describe, test, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { handleCompletions } from '../../src/host/server-request-handlers.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { Diagnostic } from '../../src/host/diagnostics.js';

/** Build a fake IncomingMessage that yields a JSON body and then ends. */
function makeFakeRequest(body: string): IncomingMessage {
  const ee = new EventEmitter() as IncomingMessage;
  // Provide async iterator for `readBody`.
  (ee as unknown as { [Symbol.asyncIterator]: () => AsyncIterator<Buffer> })[
    Symbol.asyncIterator
  ] = async function* () {
    yield Buffer.from(body, 'utf8');
  };
  return ee;
}

/** Accumulate res.write calls into an array for assertion. */
function makeFakeResponse(): {
  res: ServerResponse;
  writes: string[];
  headers: Record<string, string | number>;
  status: number;
  body: string;
  ended: boolean;
} {
  const writes: string[] = [];
  let status = 0;
  const headers: Record<string, string | number> = {};
  let body = '';
  let ended = false;
  const res = {
    writeHead: vi.fn((s: number, h: Record<string, string | number>) => {
      status = s;
      Object.assign(headers, h);
    }),
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn((chunk?: string) => {
      if (chunk) body = String(chunk);
      ended = true;
    }),
    get writableEnded() {
      return ended;
    },
  } as unknown as ServerResponse;
  return {
    res,
    writes,
    headers,
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get ended() {
      return ended;
    },
  } as ReturnType<typeof makeFakeResponse>;
}

const baseOpts = {
  modelId: 'test-model',
  agentName: 'test-agent',
  adminCtx: {} as never,
};

const diagnostic: Diagnostic = {
  severity: 'warn',
  kind: 'catalog_populate_openapi_source_failed',
  message:
    'Skill "petstore" OpenAPI spec "https://petstore.test/openapi.json" failed to load: fetch failed',
  context: {
    skill: 'petstore',
    source: 'https://petstore.test/openapi.json',
    error: 'fetch failed',
  },
  timestamp: '2026-04-21T18:30:00.000Z',
};

describe('handleCompletions — diagnostic emission', () => {
  test('streaming mode: emits event: diagnostic after finish-reason and before [DONE]', async () => {
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
        diagnostics: [diagnostic],
      })),
    });

    // Find indices of the key frames in the SSE write stream.
    const allWrites = captured.writes.join('');
    const finishIdx = captured.writes.findIndex((w) =>
      w.includes('"finish_reason":"stop"'),
    );
    const diagIdx = captured.writes.findIndex((w) =>
      w.startsWith('event: diagnostic\n'),
    );
    const doneIdx = captured.writes.findIndex((w) =>
      w.includes('data: [DONE]'),
    );

    expect(finishIdx).toBeGreaterThanOrEqual(0);
    expect(diagIdx).toBeGreaterThan(finishIdx);
    expect(doneIdx).toBeGreaterThan(diagIdx);

    // Diagnostic frame carries the full payload — kind, message, context,
    // timestamp. The UI parses this JSON directly.
    const diagFrame = captured.writes[diagIdx];
    expect(diagFrame).toContain(
      '"kind":"catalog_populate_openapi_source_failed"',
    );
    expect(diagFrame).toContain('"severity":"warn"');
    expect(diagFrame).toContain('"skill":"petstore"');
    expect(diagFrame).toContain('"timestamp":"2026-04-21T18:30:00.000Z"');

    // Sanity: the overall stream still looks like a valid SSE completion —
    // role delta, finish_reason chunk, diagnostic, [DONE].
    expect(allWrites).toContain('"delta":{"role":"assistant"}');
    expect(allWrites).toContain('data: [DONE]');
  });

  test('streaming mode: emits one diagnostic frame per entry, in order', async () => {
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    const second: Diagnostic = {
      ...diagnostic,
      kind: 'catalog_populate_server_failed',
      message:
        'Skill "linear" MCP server "linear-prod" failed to list tools: 401',
      context: { skill: 'linear', server: 'linear-prod', error: '401' },
      timestamp: '2026-04-21T18:30:01.000Z',
    };

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
        diagnostics: [diagnostic, second],
      })),
    });

    const diagFrames = captured.writes.filter((w) =>
      w.startsWith('event: diagnostic\n'),
    );
    expect(diagFrames).toHaveLength(2);
    // Order preserved
    expect(diagFrames[0]).toContain(
      '"kind":"catalog_populate_openapi_source_failed"',
    );
    expect(diagFrames[1]).toContain('"kind":"catalog_populate_server_failed"');
  });

  test('streaming mode: empty diagnostics array produces no diagnostic frames', async () => {
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
        diagnostics: [],
      })),
    });

    const diagFrames = captured.writes.filter((w) =>
      w.startsWith('event: diagnostic\n'),
    );
    expect(diagFrames).toHaveLength(0);
    // But [DONE] still sent — clean turn ended cleanly.
    expect(captured.writes.some((w) => w.includes('data: [DONE]'))).toBe(true);
  });

  test('streaming mode: absent diagnostics field behaves identically to empty array', async () => {
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      // Legacy shape — runCompletion doesn't return diagnostics at all.
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
      })),
    });

    const diagFrames = captured.writes.filter((w) =>
      w.startsWith('event: diagnostic\n'),
    );
    expect(diagFrames).toHaveLength(0);
  });

  test('non-streaming mode: diagnostics attached as top-level field on JSON body', async () => {
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
        diagnostics: [diagnostic],
      })),
    });

    expect(captured.ended).toBe(true);
    const parsed = JSON.parse(captured.body);
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      kind: 'catalog_populate_openapi_source_failed',
      severity: 'warn',
      context: { skill: 'petstore' },
    });
    // Standard chat-completion envelope unchanged.
    expect(parsed.object).toBe('chat.completion');
    expect(parsed.choices[0].message.content).toBe('ok');
  });

  test('non-streaming mode: empty diagnostics array is still emitted as []', async () => {
    // Uniform wire shape: the chat UI (and any other in-house consumer) can
    // rely on `response.diagnostics` being an array without an undefined
    // guard. Snapshot-test churn for external REST consumers is a one-time
    // mechanical cost; a silent undefined-access bug in the UI on a clean
    // turn is not.
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
        diagnostics: [],
      })),
    });

    const parsed = JSON.parse(captured.body);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.choices[0].message.content).toBe('ok');
  });

  test('non-streaming mode: absent diagnostics field is normalized to []', async () => {
    // Legacy callers that don't populate the field still produce the
    // uniform `diagnostics: []` shape on the wire — the handler
    // normalizes `undefined` to `[]` so the UI never sees two shapes.
    const eventBus = createEventBus();
    const reqBody = JSON.stringify({
      stream: false,
      messages: [{ role: 'user', content: 'hi' }],
    });
    const req = makeFakeRequest(reqBody);
    const captured = makeFakeResponse();

    await handleCompletions(req, captured.res, {
      ...baseOpts,
      eventBus,
      runCompletion: vi.fn(async () => ({
        responseContent: 'ok',
        finishReason: 'stop' as const,
      })),
    });

    const parsed = JSON.parse(captured.body);
    expect(parsed.diagnostics).toEqual([]);
  });
});
