// src/pool-controller/controller.ts — Warm pod pool reconciliation loop.
//
// Maintains target number of warm sandbox pods per tier (light, heavy).
// Every reconcileIntervalMs:
//   1. List pods with ax.io/tier={tier} and ax.io/status=warm
//   2. Filter to Running phase only (Pending pods are starting up)
//   3. If ready < minReady → create (minReady - ready) new pods
//   4. If ready > maxReady → delete (ready - maxReady) newest idle pods
//   5. Clean up Failed/Succeeded pods (garbage collection)

import { getLogger } from '../logger.js';
import type { PoolK8sClient, TierConfig, PodTemplate } from './k8s-client.js';
import type { PoolMetrics } from './metrics.js';

const logger = getLogger().child({ component: 'pool-controller' });

export interface PoolControllerConfig {
  tiers: TierConfig[];
  reconcileIntervalMs: number;
  k8sClient: PoolK8sClient;
  metrics: PoolMetrics;
}

export interface PoolController {
  start(): void;
  stop(): void;
  /** Run a single reconciliation cycle (for testing). */
  reconcileOnce(): Promise<void>;
}

export function createPoolController(config: PoolControllerConfig): PoolController {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let reconciling = false;

  const { tiers, reconcileIntervalMs, k8sClient, metrics } = config;

  // Initialize metrics targets
  for (const tier of tiers) {
    metrics.targetPods.set(tier.tier, tier.minReady);
    metrics.warmPods.set(tier.tier, 0);
    metrics.podsCreated.set(tier.tier, 0);
    metrics.podsDeleted.set(tier.tier, 0);
    metrics.podsClaimed.set(tier.tier, 0);
    metrics.poolMisses.set(tier.tier, 0);
    metrics.startupLatencies.set(tier.tier, []);
  }

  async function reconcile(): Promise<void> {
    if (reconciling) return;  // Skip if previous cycle still running
    reconciling = true;
    const start = Date.now();

    try {
      for (const tierConfig of tiers) {
        await reconcileTier(tierConfig);
      }
    } catch (err) {
      logger.error('reconcile_error', { error: (err as Error).message });
    } finally {
      metrics.lastReconcileDurationMs = Date.now() - start;
      metrics.reconcileCount++;
      reconciling = false;
    }
  }

  async function reconcileTier(tierConfig: TierConfig): Promise<void> {
    const { tier, minReady, maxReady, template } = tierConfig;

    const allPods = await k8sClient.listPods(tier);

    // Warm + Running = ready to serve
    const warmRunning = allPods.filter(
      p => p.status === 'warm' && p.phase === 'Running',
    );
    // Warm + Pending = still starting up (count them toward intent)
    const warmPending = allPods.filter(
      p => p.status === 'warm' && p.phase === 'Pending',
    );
    // Failed or Succeeded = garbage collect
    const terminal = allPods.filter(
      p => p.phase === 'Succeeded' || p.phase === 'Failed',
    );

    const readyCount = warmRunning.length;
    const pendingCount = warmPending.length;
    const effectiveCount = readyCount + pendingCount;  // Pods heading toward warm

    metrics.warmPods.set(tier, readyCount);

    logger.debug('reconcile_tier', {
      tier,
      ready: readyCount,
      pending: pendingCount,
      terminal: terminal.length,
      target: minReady,
    });

    // Scale up: create pods to reach minReady (accounting for pending)
    if (effectiveCount < minReady) {
      const toCreate = minReady - effectiveCount;
      logger.info('scaling_up', { tier, toCreate, current: effectiveCount, target: minReady });

      for (let i = 0; i < toCreate; i++) {
        try {
          await k8sClient.createPod(template);
          metrics.podsCreated.set(tier, (metrics.podsCreated.get(tier) ?? 0) + 1);
        } catch (err) {
          logger.error('create_pod_failed', { tier, error: (err as Error).message });
          break;  // Don't keep trying if k8s API is unhappy
        }
      }
    }

    // Scale down: remove excess warm pods (newest first, they've served least)
    if (readyCount > maxReady) {
      const toDelete = readyCount - maxReady;
      logger.info('scaling_down', { tier, toDelete, current: readyCount, max: maxReady });

      // Sort by creation time descending (newest first)
      const sortedWarm = [...warmRunning].sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
      );

      for (let i = 0; i < toDelete && i < sortedWarm.length; i++) {
        try {
          await k8sClient.deletePod(sortedWarm[i].name);
          metrics.podsDeleted.set(tier, (metrics.podsDeleted.get(tier) ?? 0) + 1);
        } catch (err) {
          logger.error('delete_pod_failed', {
            tier,
            pod: sortedWarm[i].name,
            error: (err as Error).message,
          });
        }
      }
    }

    // Garbage collect terminal pods (Failed/Succeeded — includes pods that processed work and exited)
    for (const pod of terminal) {
      try {
        await k8sClient.deletePod(pod.name);
        logger.debug('gc_terminal_pod', { name: pod.name, phase: pod.phase, status: pod.status });
      } catch (err) {
        logger.warn('gc_delete_failed', {
          name: pod.name,
          error: (err as Error).message,
        });
      }
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;

      logger.info('controller_start', {
        tiers: tiers.map(t => ({
          tier: t.tier,
          minReady: t.minReady,
          maxReady: t.maxReady,
        })),
        intervalMs: reconcileIntervalMs,
      });

      // Run immediately, then on interval
      void reconcile();
      timer = setInterval(() => {
        void reconcile();
      }, reconcileIntervalMs);
    },

    stop(): void {
      if (!running) return;
      running = false;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      logger.info('controller_stop');
    },

    reconcileOnce: reconcile,
  };
}
