// src/pool-controller/main.ts — Entry point for the pool controller process.
//
// Starts the reconciliation loop and metrics server.
// Handles SIGTERM/SIGINT for graceful shutdown.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { createPoolController } from './controller.js';
import { createPoolK8sClient, type TierConfig } from './k8s-client.js';
import { createPoolMetrics, startMetricsServer } from './metrics.js';

/**
 * Load tier configurations from JSON files when SANDBOX_TEMPLATE_DIR is set,
 * otherwise return hardcoded defaults. Templates only control resources and
 * config — security context (gVisor, readOnlyRoot, drop ALL caps) stays
 * hardcoded in k8s-client.ts:createPod().
 */
export function loadTierConfigs(): TierConfig[] {
  const templateDir = process.env.SANDBOX_TEMPLATE_DIR;

  if (templateDir) {
    const tiers: TierConfig[] = [];
    for (const name of ['light', 'heavy']) {
      const filePath = join(templateDir, `${name}.json`);
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8');
        tiers.push(JSON.parse(raw) as TierConfig);
      }
    }
    if (tiers.length > 0) return tiers;
    // Fall through to defaults if no files found
  }

  const natsUrl = process.env.NATS_URL ?? 'nats://nats.ax.svc.cluster.local:4222';
  const image = process.env.K8S_POD_IMAGE ?? 'ax/agent:latest';

  return [
    {
      tier: 'light',
      minReady: parseInt(process.env.LIGHT_MIN_READY ?? '2', 10),
      maxReady: parseInt(process.env.LIGHT_MAX_READY ?? '10', 10),
      template: {
        image,
        command: ['node', '/opt/ax/dist/agent/runner.js'],
        cpu: '1',
        memory: '2Gi',
        tier: 'light',
        natsUrl,
        workspaceRoot: '/workspace',
      },
    },
    {
      tier: 'heavy',
      minReady: parseInt(process.env.HEAVY_MIN_READY ?? '0', 10),
      maxReady: parseInt(process.env.HEAVY_MAX_READY ?? '3', 10),
      template: {
        image,
        command: ['node', '/opt/ax/dist/agent/runner.js'],
        cpu: '4',
        memory: '16Gi',
        tier: 'heavy',
        natsUrl,
        workspaceRoot: '/workspace',
        nodeSelector: { 'cloud.google.com/compute-class': 'Performance' },
      },
    },
  ];
}

async function main(): Promise<void> {
  const k8sClient = await createPoolK8sClient();
  const metrics = createPoolMetrics();

  const tiers = loadTierConfigs();
  const reconcileIntervalMs = parseInt(process.env.RECONCILE_INTERVAL_MS ?? '5000', 10);

  const controller = createPoolController({
    tiers,
    reconcileIntervalMs,
    k8sClient,
    metrics,
  });

  const metricsServer = startMetricsServer(metrics);

  controller.start();
  console.log('[pool-controller] started');

  // Graceful shutdown
  const shutdown = () => {
    console.log('[pool-controller] shutting down...');
    controller.stop();
    metricsServer.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[pool-controller] fatal:', err);
  process.exit(1);
});
