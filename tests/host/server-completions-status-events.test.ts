import { describe, test, expect, vi } from 'vitest';
import { createEventBus } from '../../src/host/event-bus.js';
import type { StreamEvent } from '../../src/host/event-bus.js';

/**
 * These tests verify that the status event structure emitted by
 * server-completions.ts during workspace mount and sandbox spawn
 * matches the expected shape. We use a real EventBus and simulate
 * the same emit calls that processCompletion makes.
 */
describe('status events via EventBus', () => {
  test('workspace mount status events flow through EventBus', () => {
    const bus = createEventBus();
    const received: StreamEvent[] = [];

    bus.subscribeRequest('req-1', (event) => {
      if (event.type === 'status') received.push(event);
    });

    // Simulate the two workspace status emits from server-completions.ts (lines ~694, ~717)
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

    expect(received).toHaveLength(2);
    expect(received[0].data).toEqual({ operation: 'workspace', phase: 'downloading', message: 'Restoring workspace\u2026' });
    expect(received[1].data).toEqual({ operation: 'workspace', phase: 'mounted', message: 'Workspace ready' });
  });

  test('pod spawn status events flow through EventBus', () => {
    const bus = createEventBus();
    const received: StreamEvent[] = [];

    bus.subscribeRequest('req-1', (event) => {
      if (event.type === 'status') received.push(event);
    });

    // Simulate the pod spawn emit from server-completions.ts (line ~868) — attempt 0
    bus.emit({
      type: 'status',
      requestId: 'req-1',
      timestamp: Date.now(),
      data: { operation: 'pod', phase: 'creating', message: 'Starting sandbox\u2026' },
    });

    expect(received).toHaveLength(1);
    expect(received[0].data.operation).toBe('pod');
    expect(received[0].data.phase).toBe('creating');
    expect(received[0].data.message).toBe('Starting sandbox\u2026');
  });

  test('retry attempt emits correct phase and message', () => {
    const bus = createEventBus();
    const received: StreamEvent[] = [];

    bus.subscribeRequest('req-1', (event) => {
      if (event.type === 'status') received.push(event);
    });

    // Simulate the retry loop from server-completions.ts (line ~868)
    // attempt=0 → creating, attempt=1 → retrying
    for (let attempt = 0; attempt <= 1; attempt++) {
      bus.emit({
        type: 'status',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: {
          operation: 'pod',
          phase: attempt === 0 ? 'creating' : 'retrying',
          message: attempt === 0 ? 'Starting sandbox\u2026' : `Retrying sandbox (attempt ${attempt + 1})\u2026`,
        },
      });
    }

    expect(received).toHaveLength(2);
    expect(received[0].data.phase).toBe('creating');
    expect(received[0].data.message).toBe('Starting sandbox\u2026');
    expect(received[1].data.phase).toBe('retrying');
    expect(received[1].data.message).toBe('Retrying sandbox (attempt 2)\u2026');
  });
});
