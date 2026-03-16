// src/providers/sandbox/warm-pool-client.ts — Claims warm pods from the pool for sandbox use.
//
// The pool controller maintains a set of warm pods per tier. This client
// claims a warm pod by patching its label from 'warm' → 'claimed', then
// returns the pod name so the k8s sandbox provider can exec into it.
//
// Race conditions: Multiple host instances may try to claim the same pod.
// We use optimistic concurrency — if the patch fails (409 Conflict or 404),
// we retry with the next available pod. At worst, a host falls back to
// cold-starting a new pod.

import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'warm-pool-client' });

/** Result of a successful pod claim. */
export interface ClaimedPod {
  name: string;
  tier: string;
}

/** Client for claiming warm pods from the pool. */
export interface WarmPoolClient {
  /**
   * Try to claim a warm Running pod from the given tier.
   * Returns the pod name on success, or null if no warm pods are available.
   */
  claimPod(tier: string): Promise<ClaimedPod | null>;

  /** Delete a claimed pod after use (pods are disposable, not returned to pool). */
  releasePod(name: string): Promise<void>;
}

/**
 * Create a warm pool client backed by Kubernetes API.
 *
 * @param namespace - K8s namespace (default: env K8S_NAMESPACE or 'ax')
 */
export async function createWarmPoolClient(namespace?: string): Promise<WarmPoolClient> {
  const k8s = await import('@kubernetes/client-node');

  const kc = new k8s.KubeConfig();
  try {
    kc.loadFromCluster();
  } catch {
    kc.loadFromDefault();
  }

  const api = kc.makeApiClient(k8s.CoreV1Api);
  const ns = namespace ?? process.env.K8S_NAMESPACE ?? 'ax';

  return {
    async claimPod(tier: string): Promise<ClaimedPod | null> {
      // List warm pods for this tier
      const labelSelector = `app.kubernetes.io/name=ax-sandbox,ax.io/tier=${tier},ax.io/status=warm`;
      let pods;
      try {
        pods = await api.listNamespacedPod({ namespace: ns, labelSelector });
      } catch (err: unknown) {
        logger.warn('claim_list_failed', { tier, error: (err as Error).message });
        return null;
      }

      // Filter to Running pods only (Pending pods aren't ready yet)
      const warmRunning = (pods.items ?? []).filter(
        (pod) => pod.status?.phase === 'Running',
      );

      if (warmRunning.length === 0) {
        logger.debug('no_warm_pods', { tier });
        return null;
      }

      // Sort by creation time ascending (oldest first — most likely fully ready)
      warmRunning.sort((a, b) => {
        const aTime = a.metadata?.creationTimestamp
          ? new Date(a.metadata.creationTimestamp).getTime()
          : 0;
        const bTime = b.metadata?.creationTimestamp
          ? new Date(b.metadata.creationTimestamp).getTime()
          : 0;
        return aTime - bTime;
      });

      // Try to claim each pod in order (optimistic concurrency)
      for (const pod of warmRunning) {
        const podName = pod.metadata?.name;
        if (!podName) continue;

        try {
          // Atomic compare-and-swap: the JSON Patch 'test' op verifies the
          // label is still 'warm' before replacing it with 'claimed'. If
          // another host already claimed this pod, the test fails with 422.
          // Note: '/' in label key ax.io/status is escaped as ~1 per RFC 6901.
          await api.patchNamespacedPod(
            {
              namespace: ns,
              name: podName,
              body: [
                { op: 'test', path: '/metadata/labels/ax.io~1status', value: 'warm' },
                { op: 'replace', path: '/metadata/labels/ax.io~1status', value: 'claimed' },
              ],
            },
            // Content-Type: application/json-patch+json is set automatically by the K8s client for patch ops
          );

          logger.info('pod_claimed', { podName, tier });
          return { name: podName, tier };
        } catch (err: unknown) {
          const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
          if (status === 404 || status === 409 || status === 422) {
            // 404: pod deleted, 409: conflict, 422: JSON Patch test failed (already claimed)
            logger.debug('claim_conflict', { podName, status });
            continue;
          }
          logger.warn('claim_patch_failed', { podName, error: (err as Error).message });
          // Don't try more pods if the API itself is failing
          return null;
        }
      }

      logger.debug('all_claims_failed', { tier, attempted: warmRunning.length });
      return null;
    },

    async releasePod(name: string): Promise<void> {
      try {
        await api.deleteNamespacedPod({
          namespace: ns,
          name,
          gracePeriodSeconds: 10,
        });
        logger.info('pod_released', { name });
      } catch (err: unknown) {
        const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
        if (status === 404) {
          logger.debug('pod_already_released', { name });
          return;
        }
        logger.warn('pod_release_failed', { name, error: (err as Error).message });
      }
    },
  };
}
