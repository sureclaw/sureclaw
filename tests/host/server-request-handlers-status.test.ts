import { describe, test, expect, vi } from 'vitest';
import { createEventBus } from '../../src/host/event-bus.js';

/**
 * Tests that the SSE forwarding contract in server-request-handlers.ts
 * correctly converts status StreamEvents into named SSE events.
 *
 * We simulate the subscription + event handler inline (same logic as
 * handleCompletions) and assert the SSE output written to the response.
 */

/** Simulate the SSE forwarding logic from handleCompletions (lines ~160-206). */
function simulateSSEForwarding(
  bus: ReturnType<typeof createEventBus>,
  requestId: string,
  res: { write: ReturnType<typeof vi.fn> },
) {
  return bus.subscribeRequest(requestId, (event) => {
    if (
      event.type === 'status' &&
      typeof event.data.operation === 'string' &&
      typeof event.data.phase === 'string' &&
      typeof event.data.message === 'string'
    ) {
      // Mirrors sendSSENamedEvent(res, 'status', { ... })
      res.write(`event: status\ndata: ${JSON.stringify({
        operation: event.data.operation,
        phase: event.data.phase,
        message: event.data.message,
      })}\n\n`);
    }
  });
}

describe('status event SSE forwarding', () => {
  test('status events are forwarded as named SSE events', () => {
    const bus = createEventBus();
    const res = { write: vi.fn() };

    const unsubscribe = simulateSSEForwarding(bus, 'req-1', res);

    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'workspace', phase: 'downloading', message: 'Restoring workspace\u2026' },
    });

    expect(res.write).toHaveBeenCalledTimes(1);
    const written = res.write.mock.calls[0][0] as string;
    expect(written).toContain('event: status');
    expect(written).toContain('"operation":"workspace"');
    expect(written).toContain('"phase":"downloading"');
    expect(written).toContain('"message":"Restoring workspace\u2026"');

    unsubscribe();
  });

  test('status events only reach correct requestId subscriber', () => {
    const bus = createEventBus();
    const res = { write: vi.fn() };

    const unsubscribe = simulateSSEForwarding(bus, 'req-1', res);

    // Emit for a different requestId
    bus.emit({
      type: 'status',
      requestId: 'req-2',
      timestamp: Date.now(),
      data: { operation: 'pod', phase: 'creating', message: 'Starting sandbox\u2026' },
    });

    expect(res.write).not.toHaveBeenCalled();

    unsubscribe();
  });

  test('malformed status events are not forwarded', () => {
    const bus = createEventBus();
    const res = { write: vi.fn() };

    const unsubscribe = simulateSSEForwarding(bus, 'req-1', res);

    // Missing 'message' field
    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'workspace', phase: 'downloading' },
    });

    // Wrong type for 'operation'
    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 42, phase: 'downloading', message: 'test' },
    });

    expect(res.write).not.toHaveBeenCalled();

    unsubscribe();
  });

  test('multiple status events are forwarded in sequence', () => {
    const bus = createEventBus();
    const res = { write: vi.fn() };

    const unsubscribe = simulateSSEForwarding(bus, 'req-1', res);

    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'workspace', phase: 'downloading', message: 'Restoring workspace\u2026' },
    });

    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'workspace', phase: 'mounted', message: 'Workspace ready' },
    });

    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'pod', phase: 'creating', message: 'Starting sandbox\u2026' },
    });

    expect(res.write).toHaveBeenCalledTimes(3);

    const calls = res.write.mock.calls.map((c: [string]) => c[0]);
    expect(calls[0]).toContain('"phase":"downloading"');
    expect(calls[1]).toContain('"phase":"mounted"');
    expect(calls[2]).toContain('"operation":"pod"');

    unsubscribe();
  });
});
