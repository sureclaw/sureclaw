import { describe, test, expect, beforeEach, vi } from 'vitest';
import { createPoolController, type PoolControllerConfig } from '../../src/pool-controller/controller.js';
import { createPoolMetrics } from '../../src/pool-controller/metrics.js';
import type { PoolK8sClient, PoolPod, PodTemplate, TierConfig } from '../../src/pool-controller/k8s-client.js';

function makePod(overrides: Partial<PoolPod> = {}): PoolPod {
  return {
    name: `ax-sandbox-light-${Math.random().toString(36).slice(2, 6)}`,
    tier: 'light',
    status: 'warm',
    createdAt: new Date(),
    phase: 'Running',
    ...overrides,
  };
}

const lightTemplate: PodTemplate = {
  image: 'ax/agent:latest',
  command: ['node', '/opt/ax/dist/agent/runner.js'],
  cpu: '1',
  memory: '2Gi',
  tier: 'light',
  natsUrl: 'nats://localhost:4222',
  workspaceRoot: '/workspace',
};

function createMockK8sClient(pods: PoolPod[] = []): PoolK8sClient & {
  created: string[];
  deleted: string[];
} {
  const state = [...pods];
  const created: string[] = [];
  const deleted: string[] = [];

  return {
    created,
    deleted,
    async listPods(tier: string) {
      return state.filter(p => p.tier === tier);
    },
    async createPod(template: PodTemplate) {
      const name = `ax-sandbox-${template.tier}-test-${Math.random().toString(36).slice(2, 6)}`;
      state.push(makePod({ name, tier: template.tier, phase: 'Pending' }));
      created.push(name);
      return name;
    },
    async deletePod(name: string) {
      const idx = state.findIndex(p => p.name === name);
      if (idx >= 0) state.splice(idx, 1);
      deleted.push(name);
    },
    async patchPodLabel() {},
  };
}

describe('pool-controller', () => {
  const tiers: TierConfig[] = [
    { tier: 'light', minReady: 2, maxReady: 5, template: lightTemplate },
  ];

  test('scales up when below minReady', async () => {
    const k8sClient = createMockK8sClient([]);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    expect(k8sClient.created.length).toBe(2); // minReady = 2, 0 ready
    expect(metrics.warmPods.get('light')).toBe(0); // No Running pods yet (Pending)
    expect(metrics.podsCreated.get('light')).toBe(2);
  });

  test('does not scale up when at minReady', async () => {
    const pods = [makePod(), makePod()]; // 2 warm Running pods
    const k8sClient = createMockK8sClient(pods);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    expect(k8sClient.created.length).toBe(0);
    expect(k8sClient.deleted.length).toBe(0);
    expect(metrics.warmPods.get('light')).toBe(2);
  });

  test('scales down when above maxReady', async () => {
    const pods = Array.from({ length: 7 }, () => makePod());
    const k8sClient = createMockK8sClient(pods);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    expect(k8sClient.deleted.length).toBe(2); // 7 - 5 = 2 to delete
  });

  test('accounts for pending pods when scaling up', async () => {
    const pods = [
      makePod({ phase: 'Pending' }), // warm but still starting
    ];
    const k8sClient = createMockK8sClient(pods);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    // minReady=2, 1 pending → effectiveCount=1 → create 1
    expect(k8sClient.created.length).toBe(1);
  });

  test('garbage collects Failed/Succeeded pods', async () => {
    const pods = [
      makePod(), makePod(), // 2 warm Running
      makePod({ phase: 'Failed', name: 'failed-pod' }),
      makePod({ phase: 'Succeeded', name: 'succeeded-pod' }),
    ];
    const k8sClient = createMockK8sClient(pods);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    expect(k8sClient.deleted).toContain('failed-pod');
    expect(k8sClient.deleted).toContain('succeeded-pod');
    expect(k8sClient.created.length).toBe(0); // 2 running = at minReady
  });

  test('start and stop lifecycle', async () => {
    const k8sClient = createMockK8sClient([makePod(), makePod()]);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 100, // Fast for testing
      k8sClient,
      metrics,
    });

    controller.start();
    // Wait for at least one reconciliation
    await new Promise(r => setTimeout(r, 150));
    controller.stop();

    expect(metrics.reconcileCount).toBeGreaterThanOrEqual(1);
  });

  test('updates reconcile metrics', async () => {
    const k8sClient = createMockK8sClient([]);
    const metrics = createPoolMetrics();
    const controller = createPoolController({
      tiers,
      reconcileIntervalMs: 60000,
      k8sClient,
      metrics,
    });

    await controller.reconcileOnce();

    expect(metrics.reconcileCount).toBe(1);
    expect(metrics.lastReconcileDurationMs).toBeGreaterThanOrEqual(0);
  });
});
