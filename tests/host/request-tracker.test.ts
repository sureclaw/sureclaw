import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequestTracker, type RequestTracker } from '../../src/host/request-tracker.js';

describe('RequestTracker', () => {
  let tracker: RequestTracker;

  afterEach(() => {
    tracker?.dispose();
  });

  describe('createRequestTracker', () => {
    it('returns an object with the expected API', () => {
      tracker = createRequestTracker();
      expect(typeof tracker.track).toBe('function');
      expect(typeof tracker.processing).toBe('function');
      expect(typeof tracker.done).toBe('function');
      expect(typeof tracker.fail).toBe('function');
      expect(typeof tracker.cancel).toBe('function');
      expect(typeof tracker.get).toBe('function');
      expect(typeof tracker.stats).toBe('function');
      expect(typeof tracker.dispose).toBe('function');
    });

    it('starts with empty stats', () => {
      tracker = createRequestTracker();
      const stats = tracker.stats();
      expect(stats.total).toBe(0);
      expect(stats.queued).toBe(0);
      expect(stats.processing).toBe(0);
    });
  });

  describe('lifecycle tracking', () => {
    it('tracks a new request in queued state', () => {
      tracker = createRequestTracker();
      tracker.track('req-1', { queuePosition: 3 });

      const req = tracker.get('req-1');
      expect(req).toBeDefined();
      expect(req!.state).toBe('queued');
      expect(req!.queuePosition).toBe(3);
      expect(req!.requestId).toBe('req-1');
    });

    it('transitions through full lifecycle: queued → processing → done', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');

      expect(tracker.get('req-1')!.state).toBe('queued');

      tracker.processing('req-1');
      expect(tracker.get('req-1')!.state).toBe('processing');

      tracker.done('req-1');
      expect(tracker.get('req-1')!.state).toBe('done');
    });

    it('transitions to error state with message', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');
      tracker.processing('req-1');
      tracker.fail('req-1', 'Something went wrong');

      const req = tracker.get('req-1');
      expect(req!.state).toBe('error');
      expect(req!.error).toBe('Something went wrong');
    });

    it('transitions to cancelled state', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');
      tracker.cancel('req-1');

      expect(tracker.get('req-1')!.state).toBe('cancelled');
    });

    it('stores session ID', () => {
      tracker = createRequestTracker();
      tracker.track('req-1', { sessionId: 'session-abc' });

      expect(tracker.get('req-1')!.sessionId).toBe('session-abc');
    });

    it('updates timestamps on state transitions', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');
      const created = tracker.get('req-1')!.createdAt;

      // Small delay to ensure different timestamp
      tracker.processing('req-1');
      expect(tracker.get('req-1')!.updatedAt).toBeGreaterThanOrEqual(created);
    });

    it('handles transition of non-existent request gracefully', () => {
      tracker = createRequestTracker();
      // Should not throw
      tracker.processing('nonexistent');
      tracker.done('nonexistent');
      tracker.fail('nonexistent', 'err');
      tracker.cancel('nonexistent');
    });
  });

  describe('get', () => {
    it('returns undefined for unknown request ID', () => {
      tracker = createRequestTracker();
      expect(tracker.get('unknown')).toBeUndefined();
    });
  });

  describe('stats', () => {
    it('counts requests by state', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');
      tracker.track('req-2');
      tracker.track('req-3');

      tracker.processing('req-2');
      tracker.done('req-3');

      const stats = tracker.stats();
      expect(stats.queued).toBe(1);
      expect(stats.processing).toBe(1);
      expect(stats.done).toBe(1);
      expect(stats.total).toBe(3);
    });

    it('counts error and cancelled states', () => {
      tracker = createRequestTracker();
      tracker.track('req-1');
      tracker.track('req-2');

      tracker.fail('req-1', 'err');
      tracker.cancel('req-2');

      const stats = tracker.stats();
      expect(stats.error).toBe(1);
      expect(stats.cancelled).toBe(1);
      expect(stats.total).toBe(2);
    });
  });

  describe('auto-cleanup', () => {
    it('cleans up completed entries after TTL', async () => {
      tracker = createRequestTracker({
        completedTtlMs: 50,    // 50ms TTL for testing
        cleanupIntervalMs: 25, // Run cleanup every 25ms
      });

      tracker.track('req-1');
      tracker.done('req-1');

      // Wait for cleanup to run
      await new Promise(r => setTimeout(r, 100));

      expect(tracker.get('req-1')).toBeUndefined();
      expect(tracker.stats().total).toBe(0);
    });

    it('does not clean up active requests', async () => {
      tracker = createRequestTracker({
        completedTtlMs: 50,
        cleanupIntervalMs: 25,
      });

      tracker.track('req-1');
      tracker.processing('req-1');

      // Wait for cleanup to run
      await new Promise(r => setTimeout(r, 100));

      // Active request should still be there
      expect(tracker.get('req-1')).toBeDefined();
      expect(tracker.get('req-1')!.state).toBe('processing');
    });

    it('does not clean up queued requests', async () => {
      tracker = createRequestTracker({
        completedTtlMs: 50,
        cleanupIntervalMs: 25,
      });

      tracker.track('req-1');

      await new Promise(r => setTimeout(r, 100));

      expect(tracker.get('req-1')).toBeDefined();
      expect(tracker.get('req-1')!.state).toBe('queued');
    });
  });

  describe('dispose', () => {
    it('stops the cleanup timer', () => {
      tracker = createRequestTracker({
        cleanupIntervalMs: 10,
      });

      // Should not throw
      tracker.dispose();

      // Second call should also be safe
      tracker.dispose();
    });
  });
});
