import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHeartbeatMonitor } from '../../../src/host/orchestration/heartbeat-monitor.js';
import type { EventBus, StreamEvent } from '../../../src/host/event-bus.js';
import type { AgentSupervisor } from '../../../src/host/orchestration/agent-supervisor.js';

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

function createMockSupervisor(handles: any[] = []): AgentSupervisor {
  return {
    register: vi.fn(),
    transition: vi.fn(),
    interrupt: vi.fn(),
    cancel: vi.fn(),
    complete: vi.fn(),
    fail: vi.fn(),
    get: vi.fn((id: string) => handles.find((h) => h.id === id)),
    remove: vi.fn(),
    all: vi.fn(() => handles),
    activeCount: vi.fn(() => handles.filter((h) => h.state !== 'completed').length),
  };
}

describe('HeartbeatMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('records activity from agent.* events', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    const listener = bus.captured[0];
    listener({
      type: 'agent.state',
      requestId: 'session-1',
      timestamp: Date.now(),
      data: { handleId: 'h1' },
    });

    expect(monitor.getLastActivity('h1')).not.toBeNull();
    monitor.stop();
  });

  it('ignores non-agent events', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    const listener = bus.captured[0];
    listener({
      type: 'llm.start',
      requestId: 'session-1',
      timestamp: Date.now(),
      data: {},
    });

    expect(monitor.getLastActivity('h1')).toBeNull();
    monitor.stop();
  });

  it('detects timed-out agents', () => {
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(monitor.isTimedOut('h1')).toBe(true);
  });

  it('does not report recently active agents as timed out', () => {
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(3000);

    expect(monitor.isTimedOut('h1')).toBe(false);
  });

  it('auto-interrupts stuck agents on check interval', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'running', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    // Advance past timeout + one check interval
    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).toHaveBeenCalledWith('h1', expect.stringContaining('Heartbeat timeout'));
    monitor.stop();
  });

  it('does not interrupt terminal agents', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'completed', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('does not interrupt already-interrupted agents', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'interrupted', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(6000);

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('resets timeout on new activity', () => {
    const handles = [
      { id: 'h1', agentId: 'main', state: 'running', sessionId: 's1' },
    ];
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor(handles);
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);
    monitor.recordActivity('h1');

    vi.advanceTimersByTime(4000);
    monitor.recordActivity('h1'); // Reset
    vi.advanceTimersByTime(4000); // 4s since reset, still within 5s timeout

    expect(supervisor.interrupt).not.toHaveBeenCalled();
    monitor.stop();
  });

  it('stop clears interval and unsubscribes', () => {
    const bus = createMockEventBus();
    const supervisor = createMockSupervisor();
    const monitor = createHeartbeatMonitor({ timeoutMs: 5000, checkIntervalMs: 1000 });
    monitor.start(bus, supervisor);

    expect(bus.captured).toHaveLength(1);
    monitor.stop();
    expect(bus.captured).toHaveLength(0);
  });
});
