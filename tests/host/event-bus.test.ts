import { describe, it, expect, vi } from 'vitest';
import { createEventBus, type StreamEvent, type EventBus } from '../../src/host/event-bus.js';

function makeEvent(overrides: Partial<StreamEvent> = {}): StreamEvent {
  return {
    type: 'test.event',
    requestId: 'req-1',
    timestamp: Date.now(),
    data: {},
    ...overrides,
  };
}

describe('EventBus', () => {
  describe('createEventBus', () => {
    it('returns an EventBus with the expected API', () => {
      const bus = createEventBus();
      expect(typeof bus.emit).toBe('function');
      expect(typeof bus.subscribe).toBe('function');
      expect(typeof bus.subscribeRequest).toBe('function');
      expect(typeof bus.listenerCount).toBe('function');
    });

    it('starts with zero listeners', () => {
      const bus = createEventBus();
      expect(bus.listenerCount()).toBe(0);
    });
  });

  describe('emit + subscribe', () => {
    it('delivers events to global subscribers', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      bus.subscribe((e) => received.push(e));

      const event = makeEvent({ type: 'completion.start' });
      bus.emit(event);

      expect(received).toHaveLength(1);
      expect(received[0]).toBe(event);
    });

    it('delivers events to multiple global subscribers', () => {
      const bus = createEventBus();
      const a: StreamEvent[] = [];
      const b: StreamEvent[] = [];
      bus.subscribe((e) => a.push(e));
      bus.subscribe((e) => b.push(e));

      bus.emit(makeEvent());

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });

    it('does not deliver events after unsubscribe', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      const unsub = bus.subscribe((e) => received.push(e));

      bus.emit(makeEvent());
      expect(received).toHaveLength(1);

      unsub();
      bus.emit(makeEvent());
      expect(received).toHaveLength(1);
    });

    it('unsubscribe is idempotent', () => {
      const bus = createEventBus();
      const unsub = bus.subscribe(() => {});
      expect(bus.listenerCount()).toBe(1);

      unsub();
      expect(bus.listenerCount()).toBe(0);

      // Second call should be a no-op
      unsub();
      expect(bus.listenerCount()).toBe(0);
    });

    it('listenerCount tracks global subscribers', () => {
      const bus = createEventBus();
      const unsub1 = bus.subscribe(() => {});
      expect(bus.listenerCount()).toBe(1);

      const unsub2 = bus.subscribe(() => {});
      expect(bus.listenerCount()).toBe(2);

      unsub1();
      expect(bus.listenerCount()).toBe(1);

      unsub2();
      expect(bus.listenerCount()).toBe(0);
    });
  });

  describe('subscribeRequest', () => {
    it('only receives events for the matching requestId', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      bus.subscribeRequest('req-1', (e) => received.push(e));

      bus.emit(makeEvent({ requestId: 'req-1' }));
      bus.emit(makeEvent({ requestId: 'req-2' }));

      expect(received).toHaveLength(1);
      expect(received[0].requestId).toBe('req-1');
    });

    it('does not deliver after unsubscribe', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      const unsub = bus.subscribeRequest('req-1', (e) => received.push(e));

      bus.emit(makeEvent({ requestId: 'req-1' }));
      expect(received).toHaveLength(1);

      unsub();
      bus.emit(makeEvent({ requestId: 'req-1' }));
      expect(received).toHaveLength(1);
    });

    it('cleans up empty per-request arrays on unsubscribe', () => {
      const bus = createEventBus();
      const unsub = bus.subscribeRequest('req-1', () => {});
      unsub();

      // Emitting should be fine — no lingering empty arrays cause issues
      bus.emit(makeEvent({ requestId: 'req-1' }));
    });

    it('supports multiple listeners per requestId', () => {
      const bus = createEventBus();
      const a: StreamEvent[] = [];
      const b: StreamEvent[] = [];
      bus.subscribeRequest('req-1', (e) => a.push(e));
      bus.subscribeRequest('req-1', (e) => b.push(e));

      bus.emit(makeEvent({ requestId: 'req-1' }));

      expect(a).toHaveLength(1);
      expect(b).toHaveLength(1);
    });
  });

  describe('global + request scoped together', () => {
    it('global subscriber sees all events, request subscriber sees only matching', () => {
      const bus = createEventBus();
      const global: StreamEvent[] = [];
      const scoped: StreamEvent[] = [];
      bus.subscribe((e) => global.push(e));
      bus.subscribeRequest('req-1', (e) => scoped.push(e));

      bus.emit(makeEvent({ requestId: 'req-1', type: 'a' }));
      bus.emit(makeEvent({ requestId: 'req-2', type: 'b' }));
      bus.emit(makeEvent({ requestId: 'req-1', type: 'c' }));

      expect(global).toHaveLength(3);
      expect(scoped).toHaveLength(2);
      expect(scoped.map(e => e.type)).toEqual(['a', 'c']);
    });
  });

  describe('error isolation', () => {
    it('catches and isolates listener errors (global)', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];

      bus.subscribe(() => { throw new Error('boom'); });
      bus.subscribe((e) => received.push(e));

      // Should not throw
      bus.emit(makeEvent());

      // Second listener still receives the event
      expect(received).toHaveLength(1);
    });

    it('catches and isolates listener errors (request-scoped)', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];

      bus.subscribeRequest('req-1', () => { throw new Error('boom'); });
      bus.subscribeRequest('req-1', (e) => received.push(e));

      bus.emit(makeEvent({ requestId: 'req-1' }));

      expect(received).toHaveLength(1);
    });
  });

  describe('eviction', () => {
    it('evicts oldest global subscriber when at capacity (100)', () => {
      const bus = createEventBus();
      const listeners: (() => void)[] = [];

      // Fill to capacity
      for (let i = 0; i < 100; i++) {
        listeners.push(bus.subscribe(() => {}));
      }
      expect(bus.listenerCount()).toBe(100);

      // Add one more — oldest should be evicted
      const received: StreamEvent[] = [];
      bus.subscribe((e) => received.push(e));
      expect(bus.listenerCount()).toBe(100);

      // The 101st listener should still work
      bus.emit(makeEvent());
      expect(received).toHaveLength(1);
    });

    it('evicts oldest per-request subscriber when at capacity (50)', () => {
      const bus = createEventBus();

      // Fill per-request listeners to capacity
      for (let i = 0; i < 50; i++) {
        bus.subscribeRequest('req-1', () => {});
      }

      // Add one more — should not throw
      const received: StreamEvent[] = [];
      bus.subscribeRequest('req-1', (e) => received.push(e));

      bus.emit(makeEvent({ requestId: 'req-1' }));
      expect(received).toHaveLength(1);
    });
  });

  describe('emit with no listeners', () => {
    it('does not throw when no listeners are registered', () => {
      const bus = createEventBus();
      expect(() => bus.emit(makeEvent())).not.toThrow();
    });
  });

  describe('event data integrity', () => {
    it('preserves event fields through emit', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      bus.subscribe((e) => received.push(e));

      const event = makeEvent({
        type: 'completion.done',
        requestId: 'chatcmpl-abc123',
        timestamp: 1709128800000,
        data: { finishReason: 'stop', responseLength: 42 },
      });
      bus.emit(event);

      expect(received[0]).toEqual(event);
      expect(received[0].data).toEqual({ finishReason: 'stop', responseLength: 42 });
    });
  });

  describe('thinking/reasoning events', () => {
    it('delivers llm.thinking events to subscribers', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      bus.subscribe((e) => received.push(e));

      bus.emit(makeEvent({ type: 'llm.thinking', data: { contentLength: 150 } }));

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe('llm.thinking');
      expect(received[0].data.contentLength).toBe(150);
    });

    it('delivers llm.thinking events to request-scoped subscribers', () => {
      const bus = createEventBus();
      const received: StreamEvent[] = [];
      bus.subscribeRequest('req-think', (e) => received.push(e));

      bus.emit(makeEvent({ type: 'llm.thinking', requestId: 'req-think', data: { contentLength: 42 } }));
      bus.emit(makeEvent({ type: 'llm.thinking', requestId: 'req-other', data: { contentLength: 99 } }));

      expect(received).toHaveLength(1);
      expect(received[0].requestId).toBe('req-think');
    });

    it('interleaves thinking and text events in order', () => {
      const bus = createEventBus();
      const types: string[] = [];
      bus.subscribe((e) => types.push(e.type));

      bus.emit(makeEvent({ type: 'llm.start' }));
      bus.emit(makeEvent({ type: 'llm.thinking' }));
      bus.emit(makeEvent({ type: 'llm.thinking' }));
      bus.emit(makeEvent({ type: 'llm.chunk' }));
      bus.emit(makeEvent({ type: 'llm.chunk' }));
      bus.emit(makeEvent({ type: 'llm.done' }));

      expect(types).toEqual([
        'llm.start',
        'llm.thinking',
        'llm.thinking',
        'llm.chunk',
        'llm.chunk',
        'llm.done',
      ]);
    });
  });
});
