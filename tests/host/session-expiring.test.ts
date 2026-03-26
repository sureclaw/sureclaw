import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSessionPodManager } from '../../src/host/session-pod-manager.js';

describe('session expiring flow', () => {
  afterEach(() => vi.useRealTimers());

  it('fires onExpiring callback before kill', async () => {
    vi.useFakeTimers();
    const onExpiring = vi.fn();
    const killFn = vi.fn();

    const mgr = createSessionPodManager({
      idleTimeoutMs: 10_000,
      warningLeadMs: 3_000,
      onExpiring,
      onKill: vi.fn(),
    });

    mgr.register('s1', { podName: 'pod-1', pid: 1, sessionId: 's1', kill: killFn });

    // Advance to warning time (10s - 3s = 7s)
    await vi.advanceTimersByTimeAsync(7_001);

    expect(onExpiring).toHaveBeenCalledWith('s1', expect.objectContaining({ podName: 'pod-1' }));
    expect(killFn).not.toHaveBeenCalled(); // not yet killed

    // Advance past the warning period
    await vi.advanceTimersByTimeAsync(3_001);
    expect(killFn).toHaveBeenCalled();

    mgr.shutdown();
  });
});
