import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOrchestrationEventStore } from '../../../src/host/orchestration/event-store.js';
import type { OrchestrationEvent, OrchestrationEventStore } from '../../../src/host/orchestration/types.js';
import type { EventBus, StreamEvent } from '../../../src/host/event-bus.js';

function createMockEventBus(): EventBus & { captured: Array<(e: StreamEvent) => void> } {
  const captured: Array<(e: StreamEvent) => void> = [];
  return {
    captured,
    emit: vi.fn(),
    subscribe: vi.fn((listener: (e: StreamEvent) => void) => {
      captured.push(listener);
      return () => {
        const idx = captured.indexOf(listener);
        if (idx >= 0) captured.splice(idx, 1);
      };
    }),
    subscribeRequest: vi.fn(() => vi.fn()),
    listenerCount: vi.fn(() => 0),
  };
}

function makeEvent(overrides: Partial<OrchestrationEvent> = {}): OrchestrationEvent {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    eventType: overrides.eventType ?? 'agent.state',
    handleId: overrides.handleId ?? 'handle-1',
    agentId: overrides.agentId ?? 'main',
    sessionId: overrides.sessionId ?? 'session-1',
    userId: overrides.userId ?? 'user-1',
    parentId: overrides.parentId ?? null,
    payload: overrides.payload ?? { oldState: 'spawning', newState: 'running' },
    createdAt: overrides.createdAt ?? Date.now(),
  };
}

describe('OrchestrationEventStore', () => {
  let store: OrchestrationEventStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ax-orch-test-'));
    store = await createOrchestrationEventStore(join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('append + query', () => {
    it('stores and retrieves an event', () => {
      const event = makeEvent();
      store.append(event);

      const results = store.query();
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(event.id);
      expect(results[0].eventType).toBe(event.eventType);
      expect(results[0].handleId).toBe(event.handleId);
      expect(results[0].payload).toEqual(event.payload);
    });

    it('stores multiple events in order', () => {
      const e1 = makeEvent({ createdAt: 1000 });
      const e2 = makeEvent({ createdAt: 2000 });
      const e3 = makeEvent({ createdAt: 3000 });
      store.append(e1);
      store.append(e2);
      store.append(e3);

      const results = store.query();
      expect(results).toHaveLength(3);
      expect(results[0].createdAt).toBe(1000);
      expect(results[2].createdAt).toBe(3000);
    });

    it('filters by eventType', () => {
      store.append(makeEvent({ eventType: 'agent.state' }));
      store.append(makeEvent({ eventType: 'agent.completed' }));
      store.append(makeEvent({ eventType: 'agent.state' }));

      const results = store.query({ eventType: 'agent.state' });
      expect(results).toHaveLength(2);
      expect(results.every((e) => e.eventType === 'agent.state')).toBe(true);
    });

    it('filters by handleId', () => {
      store.append(makeEvent({ handleId: 'h1' }));
      store.append(makeEvent({ handleId: 'h2' }));
      store.append(makeEvent({ handleId: 'h1' }));

      const results = store.query({ handleId: 'h1' });
      expect(results).toHaveLength(2);
    });

    it('filters by sessionId', () => {
      store.append(makeEvent({ sessionId: 's1' }));
      store.append(makeEvent({ sessionId: 's2' }));

      const results = store.query({ sessionId: 's1' });
      expect(results).toHaveLength(1);
    });

    it('filters by time range (since/until)', () => {
      store.append(makeEvent({ createdAt: 1000 }));
      store.append(makeEvent({ createdAt: 2000 }));
      store.append(makeEvent({ createdAt: 3000 }));

      const results = store.query({ since: 1500, until: 2500 });
      expect(results).toHaveLength(1);
      expect(results[0].createdAt).toBe(2000);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeEvent({ createdAt: i * 1000 }));
      }

      const results = store.query({ limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('combines multiple filters with AND', () => {
      store.append(makeEvent({ handleId: 'h1', eventType: 'agent.state' }));
      store.append(makeEvent({ handleId: 'h1', eventType: 'agent.completed' }));
      store.append(makeEvent({ handleId: 'h2', eventType: 'agent.state' }));

      const results = store.query({ handleId: 'h1', eventType: 'agent.state' });
      expect(results).toHaveLength(1);
    });
  });

  describe('byAgent', () => {
    it('returns events for a specific handle ordered by time', () => {
      store.append(makeEvent({ handleId: 'h1', createdAt: 2000 }));
      store.append(makeEvent({ handleId: 'h2', createdAt: 1000 }));
      store.append(makeEvent({ handleId: 'h1', createdAt: 3000 }));

      const results = store.byAgent('h1');
      expect(results).toHaveLength(2);
      expect(results[0].createdAt).toBe(2000);
      expect(results[1].createdAt).toBe(3000);
    });

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        store.append(makeEvent({ handleId: 'h1', createdAt: i * 1000 }));
      }
      const results = store.byAgent('h1', 3);
      expect(results).toHaveLength(3);
    });
  });

  describe('bySession', () => {
    it('returns events for a specific session', () => {
      store.append(makeEvent({ sessionId: 's1' }));
      store.append(makeEvent({ sessionId: 's2' }));
      store.append(makeEvent({ sessionId: 's1' }));

      const results = store.bySession('s1');
      expect(results).toHaveLength(2);
    });
  });

  describe('startCapture', () => {
    it('auto-captures agent.* events from EventBus', () => {
      const bus = createMockEventBus();
      const unsub = store.startCapture(bus);

      expect(bus.subscribe).toHaveBeenCalledOnce();

      // Simulate an agent event
      const listener = bus.captured[0];
      listener({
        type: 'agent.state',
        requestId: 'session-1',
        timestamp: Date.now(),
        data: {
          handleId: 'h1',
          agentId: 'main',
          userId: 'user-1',
          parentId: null,
          oldState: 'spawning',
          newState: 'running',
        },
      });

      const results = store.query();
      expect(results).toHaveLength(1);
      expect(results[0].eventType).toBe('agent.state');
      expect(results[0].handleId).toBe('h1');
      expect(results[0].sessionId).toBe('session-1');

      unsub();
    });

    it('ignores non-agent events', () => {
      const bus = createMockEventBus();
      store.startCapture(bus);

      const listener = bus.captured[0];
      listener({
        type: 'llm.start',
        requestId: 'req-1',
        timestamp: Date.now(),
        data: { model: 'claude' },
      });

      expect(store.query()).toHaveLength(0);
    });

    it('unsubscribe stops capture', () => {
      const bus = createMockEventBus();
      const unsub = store.startCapture(bus);
      unsub();

      expect(bus.captured).toHaveLength(0);
    });
  });
});
