import { describe, test, expect } from 'vitest';
import { createPoolMetrics, formatMetrics } from '../../src/pool-controller/metrics.js';

describe('pool-controller metrics', () => {
  test('createPoolMetrics initializes empty state', () => {
    const m = createPoolMetrics();
    expect(m.warmPods.size).toBe(0);
    expect(m.targetPods.size).toBe(0);
    expect(m.reconcileCount).toBe(0);
    expect(m.lastReconcileDurationMs).toBe(0);
  });

  test('formatMetrics produces Prometheus exposition format', () => {
    const m = createPoolMetrics();
    m.warmPods.set('light', 3);
    m.warmPods.set('heavy', 1);
    m.targetPods.set('light', 5);
    m.targetPods.set('heavy', 2);
    m.podsCreated.set('light', 10);
    m.podsDeleted.set('light', 2);
    m.podsClaimed.set('light', 7);
    m.poolMisses.set('light', 3);
    m.reconcileCount = 42;
    m.lastReconcileDurationMs = 15;
    m.startupLatencies.set('light', [1000, 2000, 3000]);

    const output = formatMetrics(m);

    expect(output).toContain('ax_warm_pods_available{tier="light"} 3');
    expect(output).toContain('ax_warm_pods_available{tier="heavy"} 1');
    expect(output).toContain('ax_warm_pods_target{tier="light"} 5');
    expect(output).toContain('ax_warm_pods_target{tier="heavy"} 2');
    expect(output).toContain('ax_pods_created_total{tier="light"} 10');
    expect(output).toContain('ax_pods_deleted_total{tier="light"} 2');
    expect(output).toContain('ax_pods_claimed_total{tier="light"} 7');
    expect(output).toContain('ax_pool_misses_total{tier="light"} 3');
    expect(output).toContain('ax_reconcile_total 42');
    expect(output).toContain('ax_reconcile_duration_ms 15');
    // Avg startup latency: (1000+2000+3000)/3 = 2000ms = 2.000s
    expect(output).toContain('ax_pod_startup_latency_seconds{tier="light"} 2.000');

    // Verify TYPE and HELP markers
    expect(output).toContain('# TYPE ax_warm_pods_available gauge');
    expect(output).toContain('# HELP ax_warm_pods_available');
    expect(output).toContain('# TYPE ax_pods_claimed_total counter');
    expect(output).toContain('# TYPE ax_pool_misses_total counter');
  });

  test('formatMetrics handles empty state', () => {
    const m = createPoolMetrics();
    const output = formatMetrics(m);

    expect(output).toContain('ax_reconcile_total 0');
    expect(output).toContain('ax_reconcile_duration_ms 0');
    // No tier data — gauges should not appear
    expect(output).not.toContain('ax_warm_pods_available{');
  });
});
