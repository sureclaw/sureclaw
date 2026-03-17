// src/pool-controller/k8s-client.ts — Kubernetes pod CRUD for pool management.
//
// Provides a thin wrapper around @kubernetes/client-node for creating,
// listing, and deleting sandbox pods. Used by the pool controller to
// maintain warm pod counts per tier.

import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'pool-k8s-client' });

/** Pod status as tracked by the pool controller.
 *  With queue group claiming, pods only have 'warm' status — NATS handles
 *  work dispatch, so there's no 'claimed' label transition. */
export type PodPoolStatus = 'warm' | 'releasing';

/** Tier configuration for sandbox pods. */
export interface TierConfig {
  tier: string;
  minReady: number;
  maxReady: number;
  /** Pod template (base manifest) to clone when creating new pods. */
  template: PodTemplate;
}

/** Minimal pod template for creating warm pods. */
export interface PodTemplate {
  image: string;
  /** Command to run inside the warm pod. Defaults to a standby entrypoint
   *  that keeps the container alive until the host exec's the agent. */
  command: string[];
  cpu: string;
  memory: string;
  tier: string;
  natsUrl: string;
  workspaceRoot: string;
  runtimeClassName?: string;
  nodeSelector?: Record<string, string>;
  activeDeadlineSeconds?: number;
}

/**
 * Default warm pod command. The runner connects to NATS and subscribes
 * to agent.work.{POD_NAME}, waiting for work. When work arrives, it
 * processes one request and exits. The runner IS the standby.
 */
export const WARM_POD_RUNNER_COMMAND = ['node', '/opt/ax/dist/agent/runner.js', '--agent', 'pi-coding-agent'];

/** Summary of a sandbox pod for pool management. */
export interface PoolPod {
  name: string;
  tier: string;
  status: PodPoolStatus;
  createdAt: Date;
  phase: string;  // k8s pod phase: Pending, Running, Succeeded, Failed
}

/** K8s client interface for pool management — mockable for tests. */
export interface PoolK8sClient {
  listPods(tier: string): Promise<PoolPod[]>;
  createPod(template: PodTemplate): Promise<string>;
  deletePod(name: string): Promise<void>;
  patchPodLabel(name: string, label: string, value: string): Promise<void>;
}

/**
 * Create a real Kubernetes client for pool management.
 * Uses in-cluster config when running in k8s, falls back to kubeconfig locally.
 */
export async function createPoolK8sClient(namespace?: string): Promise<PoolK8sClient> {
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
    async listPods(tier: string): Promise<PoolPod[]> {
      const labelSelector = `app.kubernetes.io/name=ax-sandbox,ax.io/tier=${tier}`;
      const response = await api.listNamespacedPod({
        namespace: ns,
        labelSelector,
      });

      return (response.items ?? []).map((pod) => ({
        name: pod.metadata?.name ?? '',
        tier: pod.metadata?.labels?.['ax.io/tier'] ?? tier,
        status: (pod.metadata?.labels?.['ax.io/status'] as PodPoolStatus) ?? 'warm',
        createdAt: pod.metadata?.creationTimestamp
          ? new Date(pod.metadata.creationTimestamp)
          : new Date(),
        phase: pod.status?.phase ?? 'Unknown',
      }));
    },

    async createPod(template: PodTemplate): Promise<string> {
      const podName = `ax-sandbox-${template.tier}-${randomSuffix()}`;

      const manifest = {
        apiVersion: 'v1' as const,
        kind: 'Pod' as const,
        metadata: {
          name: podName,
          namespace: ns,
          labels: {
            'app.kubernetes.io/name': 'ax-sandbox',
            'app.kubernetes.io/component': 'execution',
            'ax.io/plane': 'execution',
            'ax.io/tier': template.tier,
            'ax.io/status': 'warm',
          },
        },
        spec: {
          ...(template.runtimeClassName ? { runtimeClassName: template.runtimeClassName } : {}),
          restartPolicy: 'Never' as const,
          automountServiceAccountToken: false,
          hostNetwork: false,
          activeDeadlineSeconds: template.activeDeadlineSeconds ?? 3600,
          ...(template.nodeSelector ? { nodeSelector: template.nodeSelector } : {}),
          ...(process.env.K8S_IMAGE_PULL_SECRETS ? {
            imagePullSecrets: process.env.K8S_IMAGE_PULL_SECRETS.split(',').map(s => ({ name: s.trim() })),
          } : {}),
          containers: [
            {
              name: 'sandbox',
              image: template.image,
              ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
              command: template.command,
              workingDir: '/workspace',
              env: [
                { name: 'NATS_URL', value: template.natsUrl },
                { name: 'AX_IPC_TRANSPORT', value: 'http' },
                { name: 'AX_HOST_URL', value: process.env.AX_HOST_URL ?? `http://ax-host.${ns}.svc` },
                { name: 'AX_WORKSPACE', value: '/workspace' },
                { name: 'AX_AGENT_WORKSPACE', value: '/workspace/agent' },
                { name: 'AX_USER_WORKSPACE', value: '/workspace/user' },
                { name: 'SANDBOX_TIER', value: template.tier },
                { name: 'LOG_LEVEL', value: process.env.AX_VERBOSE === '1' ? 'debug' : 'warn' },
                { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
                // NATS sandbox user credentials (static auth)
                ...(process.env.NATS_SANDBOX_PASS ? [
                  { name: 'NATS_USER', value: 'sandbox' },
                  { name: 'NATS_PASS', value: process.env.NATS_SANDBOX_PASS },
                ] : []),
              ],
              resources: {
                requests: { cpu: template.cpu, memory: template.memory },
                limits: { cpu: template.cpu, memory: template.memory },
              },
              securityContext: {
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                runAsNonRoot: true,
                runAsUser: 1000,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'scratch', mountPath: '/workspace/scratch' },
                { name: 'agent-ws', mountPath: '/workspace/agent' },
                { name: 'user-ws', mountPath: '/workspace/user' },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'scratch', emptyDir: { sizeLimit: template.tier === 'heavy' ? '50Gi' : '10Gi' } },
            { name: 'agent-ws', emptyDir: { sizeLimit: '10Gi' } },
            { name: 'user-ws', emptyDir: { sizeLimit: '10Gi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
          ],
        },
      };

      await api.createNamespacedPod({ namespace: ns, body: manifest });
      logger.info('pod_created', { name: podName, tier: template.tier });
      return podName;
    },

    async deletePod(name: string): Promise<void> {
      try {
        await api.deleteNamespacedPod({ namespace: ns, name, gracePeriodSeconds: 10 });
        logger.info('pod_deleted', { name });
      } catch (err: unknown) {
        const status = (err as { response?: { statusCode?: number } }).response?.statusCode;
        if (status === 404) {
          logger.debug('pod_already_deleted', { name });
          return;
        }
        throw err;
      }
    },

    async patchPodLabel(name: string, label: string, value: string): Promise<void> {
      await api.patchNamespacedPod(
        { namespace: ns, name, body: { metadata: { labels: { [label]: value } } } },
      );
    },
  };
}

/** Generate a short random suffix for pod names. */
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
