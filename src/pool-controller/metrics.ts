// src/pool-controller/metrics.ts — Prometheus metrics for the pool controller.
//
// Exposes /metrics endpoint with warm pool gauges and pod startup latency.

import { createServer, type Server } from 'node:http';

/** Pool metrics state — updated by the controller, read by the HTTP endpoint. */
export interface PoolMetrics {
  /** Current warm pod counts by tier. */
  warmPods: Map<string, number>;
  /** Target warm pod counts by tier. */
  targetPods: Map<string, number>;
  /** Pod startup latencies (most recent per tier). */
  startupLatencies: Map<string, number[]>;
  /** Total pods created since controller start. */
  podsCreated: Map<string, number>;
  /** Total pods deleted since controller start. */
  podsDeleted: Map<string, number>;
  /** Total warm pod claims (successful). */
  podsClaimed: Map<string, number>;
  /** Total warm pool misses (no warm pod available, fell back to cold start). */
  poolMisses: Map<string, number>;
  /** Last reconciliation duration in ms. */
  lastReconcileDurationMs: number;
  /** Total reconciliation cycles. */
  reconcileCount: number;
}

export function createPoolMetrics(): PoolMetrics {
  return {
    warmPods: new Map(),
    targetPods: new Map(),
    startupLatencies: new Map(),
    podsCreated: new Map(),
    podsDeleted: new Map(),
    podsClaimed: new Map(),
    poolMisses: new Map(),
    lastReconcileDurationMs: 0,
    reconcileCount: 0,
  };
}

/** Format metrics in Prometheus text exposition format. */
export function formatMetrics(m: PoolMetrics): string {
  const lines: string[] = [];

  // Warm pods available
  lines.push('# HELP ax_warm_pods_available Number of warm sandbox pods available');
  lines.push('# TYPE ax_warm_pods_available gauge');
  for (const [tier, count] of m.warmPods) {
    lines.push(`ax_warm_pods_available{tier="${tier}"} ${count}`);
  }

  // Target warm pods
  lines.push('# HELP ax_warm_pods_target Target number of warm sandbox pods');
  lines.push('# TYPE ax_warm_pods_target gauge');
  for (const [tier, count] of m.targetPods) {
    lines.push(`ax_warm_pods_target{tier="${tier}"} ${count}`);
  }

  // Pod startup latency (histogram approximation via last N samples)
  lines.push('# HELP ax_pod_startup_latency_seconds Pod startup latency');
  lines.push('# TYPE ax_pod_startup_latency_seconds gauge');
  for (const [tier, latencies] of m.startupLatencies) {
    if (latencies.length > 0) {
      const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      lines.push(`ax_pod_startup_latency_seconds{tier="${tier}"} ${(avg / 1000).toFixed(3)}`);
    }
  }

  // Pods created total
  lines.push('# HELP ax_pods_created_total Total pods created by pool controller');
  lines.push('# TYPE ax_pods_created_total counter');
  for (const [tier, count] of m.podsCreated) {
    lines.push(`ax_pods_created_total{tier="${tier}"} ${count}`);
  }

  // Pods deleted total
  lines.push('# HELP ax_pods_deleted_total Total pods deleted by pool controller');
  lines.push('# TYPE ax_pods_deleted_total counter');
  for (const [tier, count] of m.podsDeleted) {
    lines.push(`ax_pods_deleted_total{tier="${tier}"} ${count}`);
  }

  // Pods claimed total (warm pool hits)
  lines.push('# HELP ax_pods_claimed_total Total warm pods claimed by sandbox hosts');
  lines.push('# TYPE ax_pods_claimed_total counter');
  for (const [tier, count] of m.podsClaimed) {
    lines.push(`ax_pods_claimed_total{tier="${tier}"} ${count}`);
  }

  // Pool misses total (no warm pod available, fell back to cold start)
  lines.push('# HELP ax_pool_misses_total Total warm pool misses (cold start fallback)');
  lines.push('# TYPE ax_pool_misses_total counter');
  for (const [tier, count] of m.poolMisses) {
    lines.push(`ax_pool_misses_total{tier="${tier}"} ${count}`);
  }

  // Reconciliation
  lines.push('# HELP ax_reconcile_duration_ms Last reconciliation duration');
  lines.push('# TYPE ax_reconcile_duration_ms gauge');
  lines.push(`ax_reconcile_duration_ms ${m.lastReconcileDurationMs}`);

  lines.push('# HELP ax_reconcile_total Total reconciliation cycles');
  lines.push('# TYPE ax_reconcile_total counter');
  lines.push(`ax_reconcile_total ${m.reconcileCount}`);

  return lines.join('\n') + '\n';
}

/** Start an HTTP server for /health and /metrics endpoints. */
export function startMetricsServer(
  metrics: PoolMetrics,
  port?: number,
): { server: Server; close: () => void } {
  const metricsPort = port ?? parseInt(process.env.METRICS_PORT ?? '9092', 10);

  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(formatMetrics(metrics));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(metricsPort, () => {
    console.log(`[pool-controller] metrics server on :${metricsPort}`);
  });

  return {
    server,
    close: () => server.close(),
  };
}
