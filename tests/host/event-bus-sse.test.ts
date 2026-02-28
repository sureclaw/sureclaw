import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { unlinkSync, existsSync } from 'node:fs';
import { createEventBus, type EventBus, type StreamEvent } from '../../src/host/event-bus.js';

/**
 * Minimal SSE server that mirrors the /v1/events endpoint logic from server.ts.
 * We test the SSE integration in isolation — no need to spin up the full AX server.
 */
function createSSEServer(eventBus: EventBus) {
  const SSE_KEEPALIVE_MS = 200; // Short for tests

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname !== '/v1/events') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    const requestIdFilter = url.searchParams.get('request_id') ?? undefined;
    const typesParam = url.searchParams.get('types') ?? undefined;
    const typeFilter = typesParam
      ? new Set(typesParam.split(',').map(t => t.trim()).filter(Boolean))
      : undefined;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    res.write(':connected\n\n');

    const listener = (event: StreamEvent) => {
      if (typeFilter && !typeFilter.has(event.type)) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch { /* client gone */ }
    };

    const unsubscribe = requestIdFilter
      ? eventBus.subscribeRequest(requestIdFilter, listener)
      : eventBus.subscribe(listener);

    const keepalive = setInterval(() => {
      try { res.write(':keepalive\n\n'); } catch { /* client gone */ }
    }, SSE_KEEPALIVE_MS);

    const cleanup = () => {
      clearInterval(keepalive);
      unsubscribe();
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  return server;
}

/** Connect to SSE endpoint and collect received data. */
function connectSSE(
  port: number,
  path: string,
): Promise<{ data: string[]; close: () => void; rawChunks: string[] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        const rawChunks: string[] = [];
        const data: string[] = [];

        res.on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          rawChunks.push(text);
          // Parse SSE data lines
          for (const line of text.split('\n')) {
            if (line.startsWith('data: ')) {
              data.push(line.slice(6));
            }
          }
        });

        // Resolve once the initial :connected comes through
        const checkConnected = () => {
          const allText = rawChunks.join('');
          if (allText.includes(':connected')) {
            resolve({
              data,
              rawChunks,
              close: () => { req.destroy(); },
            });
          }
        };

        res.on('data', checkConnected);
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function makeEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: 'test.event',
    requestId: 'req-1',
    timestamp: Date.now(),
    data: {},
    ...overrides,
  };
}

describe('SSE /v1/events endpoint', () => {
  let eventBus: EventBus;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    eventBus = createEventBus();
    server = createSSEServer(eventBus);

    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });

    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it('sends :connected on connection', async () => {
    const sse = await connectSSE(port, '/v1/events');
    try {
      const allText = sse.rawChunks.join('');
      expect(allText).toContain(':connected');
    } finally {
      sse.close();
    }
  });

  it('receives events as SSE data lines', async () => {
    const sse = await connectSSE(port, '/v1/events');
    try {
      // Give the subscription a moment to register
      await new Promise(r => setTimeout(r, 50));

      eventBus.emit(makeEvent({ type: 'completion.start', data: { sessionId: 's1' } }));

      // Wait for the SSE data to arrive
      await new Promise(r => setTimeout(r, 100));

      expect(sse.data.length).toBeGreaterThanOrEqual(1);
      const parsed = JSON.parse(sse.data[0]);
      expect(parsed.type).toBe('completion.start');
      expect(parsed.data.sessionId).toBe('s1');
    } finally {
      sse.close();
    }
  });

  it('filters by request_id when provided', async () => {
    const sse = await connectSSE(port, '/v1/events?request_id=req-1');
    try {
      await new Promise(r => setTimeout(r, 50));

      eventBus.emit(makeEvent({ requestId: 'req-1', type: 'a' }));
      eventBus.emit(makeEvent({ requestId: 'req-2', type: 'b' }));
      eventBus.emit(makeEvent({ requestId: 'req-1', type: 'c' }));

      await new Promise(r => setTimeout(r, 100));

      expect(sse.data).toHaveLength(2);
      const types = sse.data.map(d => JSON.parse(d).type);
      expect(types).toEqual(['a', 'c']);
    } finally {
      sse.close();
    }
  });

  it('filters by event types when provided', async () => {
    const sse = await connectSSE(port, '/v1/events?types=llm.start,llm.done');
    try {
      await new Promise(r => setTimeout(r, 50));

      eventBus.emit(makeEvent({ type: 'completion.start' }));
      eventBus.emit(makeEvent({ type: 'llm.start' }));
      eventBus.emit(makeEvent({ type: 'llm.chunk' }));
      eventBus.emit(makeEvent({ type: 'llm.done' }));

      await new Promise(r => setTimeout(r, 100));

      expect(sse.data).toHaveLength(2);
      const types = sse.data.map(d => JSON.parse(d).type);
      expect(types).toEqual(['llm.start', 'llm.done']);
    } finally {
      sse.close();
    }
  });

  it('sends keepalive comments', async () => {
    const sse = await connectSSE(port, '/v1/events');
    try {
      // Wait for keepalive (interval is 200ms in test)
      await new Promise(r => setTimeout(r, 350));

      const allText = sse.rawChunks.join('');
      expect(allText).toContain(':keepalive');
    } finally {
      sse.close();
    }
  });

  it('cleans up subscription on client disconnect', async () => {
    const sse = await connectSSE(port, '/v1/events');
    const initialCount = eventBus.listenerCount();
    expect(initialCount).toBe(1);

    sse.close();

    // Give the close event time to propagate
    await new Promise(r => setTimeout(r, 100));

    expect(eventBus.listenerCount()).toBe(0);
  });

  it('handles multiple concurrent SSE clients', async () => {
    const sse1 = await connectSSE(port, '/v1/events');
    const sse2 = await connectSSE(port, '/v1/events');
    try {
      await new Promise(r => setTimeout(r, 50));

      eventBus.emit(makeEvent({ type: 'shared.event' }));

      await new Promise(r => setTimeout(r, 100));

      expect(sse1.data.length).toBeGreaterThanOrEqual(1);
      expect(sse2.data.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(sse1.data[0]).type).toBe('shared.event');
      expect(JSON.parse(sse2.data[0]).type).toBe('shared.event');
    } finally {
      sse1.close();
      sse2.close();
    }
  });

  it('supports combined request_id and types filters', async () => {
    const sse = await connectSSE(port, '/v1/events?request_id=req-1&types=llm.done');
    try {
      await new Promise(r => setTimeout(r, 50));

      eventBus.emit(makeEvent({ requestId: 'req-1', type: 'llm.start' }));
      eventBus.emit(makeEvent({ requestId: 'req-1', type: 'llm.done' }));
      eventBus.emit(makeEvent({ requestId: 'req-2', type: 'llm.done' }));

      await new Promise(r => setTimeout(r, 100));

      // Only req-1 + llm.done should pass both filters
      expect(sse.data).toHaveLength(1);
      expect(JSON.parse(sse.data[0]).type).toBe('llm.done');
      expect(JSON.parse(sse.data[0]).requestId).toBe('req-1');
    } finally {
      sse.close();
    }
  });
});
