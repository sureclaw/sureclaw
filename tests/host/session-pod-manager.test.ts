import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSessionPodManager } from '../../src/host/session-pod-manager.js';

describe('SessionPodManager', () => {
  let manager: ReturnType<typeof createSessionPodManager>;
  const killFn = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    manager = createSessionPodManager({
      idleTimeoutMs: 30_000,
      cleanIdleTimeoutMs: 10_000,
      warningLeadMs: 5_000,
    });
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
    killFn.mockClear();
  });

  it('registers and retrieves a session pod', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    expect(manager.has('s1')).toBe(true);
    expect(manager.get('s1')?.podName).toBe('pod-1');
  });

  it('removes a session pod', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.remove('s1');
    expect(manager.has('s1')).toBe(false);
  });

  it('kills clean pod after clean idle timeout', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    // Clean session uses cleanIdleTimeoutMs (10s)
    await vi.advanceTimersByTimeAsync(10_001);
    expect(killFn).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });

  it('does not kill clean pod before clean idle timeout', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('dirty pod uses full idle timeout', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.markDirty('s1');
    // Should NOT be killed at the clean timeout
    await vi.advanceTimersByTimeAsync(10_001);
    expect(killFn).not.toHaveBeenCalled();
    // Should be killed at the full timeout
    await vi.advanceTimersByTimeAsync(20_000);
    expect(killFn).toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });

  it('markDirty is idempotent', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.markDirty('s1');
    manager.markDirty('s1');
    expect(manager.get('s1')?.dirty).toBe(true);
  });

  it('markDirty on unknown session is a no-op', () => {
    expect(() => manager.markDirty('unknown')).not.toThrow();
  });

  it('new sessions start clean', () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    expect(manager.get('s1')?.dirty).toBe(false);
  });

  it('touch resets idle timer', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    await vi.advanceTimersByTimeAsync(8_000);
    manager.touch('s1');
    await vi.advanceTimersByTimeAsync(8_000);
    expect(killFn).not.toHaveBeenCalled(); // only 8s since touch, not 10s
    await vi.advanceTimersByTimeAsync(2_001);
    expect(killFn).toHaveBeenCalled();
  });

  it('queues and claims work', () => {
    manager.queueWork('token-1', '{"msg":"hello"}');
    const work = manager.claimWork('token-1');
    expect(work).toBeDefined();
    expect(work!.payload).toBe('{"msg":"hello"}');
    // Resolve to prevent unhandled rejection
    work!.resolve('done');
  });

  it('claimWork returns undefined for unknown token', () => {
    expect(manager.claimWork('nope')).toBeUndefined();
  });

  it('remove clears timers without calling kill', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.remove('s1');
    // Advance past all timeouts — kill should never fire
    await vi.advanceTimersByTimeAsync(60_000);
    expect(killFn).not.toHaveBeenCalled();
    expect(manager.has('s1')).toBe(false);
  });

  it('external remove before idle timer prevents kill', async () => {
    manager.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    manager.markDirty('s1');
    // Simulate external removal (e.g. watchPodExit safety timer)
    await vi.advanceTimersByTimeAsync(15_000);
    manager.remove('s1');
    // Advance past the original idle timeout
    await vi.advanceTimersByTimeAsync(30_000);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('falls back to idleTimeoutMs when cleanIdleTimeoutMs not set', async () => {
    const mgr = createSessionPodManager({
      idleTimeoutMs: 30_000,
      warningLeadMs: 5_000,
    });
    mgr.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });
    // Clean session should still use full timeout when no cleanIdleTimeoutMs
    await vi.advanceTimersByTimeAsync(25_000);
    expect(killFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_001);
    expect(killFn).toHaveBeenCalled();
    mgr.shutdown();
  });
});
