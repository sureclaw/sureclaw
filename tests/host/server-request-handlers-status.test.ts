import { describe, test, expect } from 'vitest';
import { createEventBus } from '../../src/host/event-bus.js';

describe('status event forwarding', () => {
  test('event bus delivers status events to request subscribers', () => {
    const bus = createEventBus();
    const received: any[] = [];

    bus.subscribeRequest('req-1', (event) => {
      if (event.type === 'status') received.push(event.data);
    });

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
    expect(received[0]).toEqual({ operation: 'workspace', phase: 'downloading', message: 'Restoring workspace\u2026' });
    expect(received[1]).toEqual({ operation: 'workspace', phase: 'mounted', message: 'Workspace ready' });
  });

  test('status events only reach correct requestId subscriber', () => {
    const bus = createEventBus();
    const received: any[] = [];

    bus.subscribeRequest('req-1', (event) => {
      if (event.type === 'status') received.push(event.data);
    });

    // Emit for different requestId
    bus.emit({
      type: 'status',
      requestId: 'req-2',
      timestamp: Date.now(),
      data: { operation: 'pod', phase: 'creating', message: 'Starting sandbox\u2026' },
    });

    expect(received).toHaveLength(0);
  });
});
