/**
 * k8s sandbox provider — Kubernetes pod-based isolation.
 *
 * Creates a k8s pod for each sandbox instance. The pod runs the agent
 * subprocess with gVisor runtime, resource limits, and NATS connectivity
 * for tool dispatch and event streaming.
 *
 * The pod boundary IS the security boundary — no in-pod multi-tenant
 * isolation needed on GKE Autopilot.
 *
 * Environment:
 *   K8S_NAMESPACE — target namespace (default: "ax")
 *   K8S_POD_IMAGE — container image (default: "ax/agent:latest")
 *   K8S_RUNTIME_CLASS — runtime class name (default: "gvisor")
 *   NATS_URL — NATS server URL passed to sandbox pods
 */

import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';
import { CANONICAL, canonicalEnv } from './canonical-paths.js';

const logger = getLogger().child({ component: 'sandbox-k8s' });

const DEFAULT_IMAGE = 'ax/agent:latest';
const DEFAULT_NAMESPACE = 'ax';
const DEFAULT_RUNTIME_CLASS = 'gvisor';
const DEFAULT_CPU_LIMIT = '1';
const DEFAULT_MEMORY_LIMIT = '512Mi';

/** Synthetic PID counter — k8s pods don't have local PIDs. */
let nextPid = 100_000;

/**
 * Build a k8s pod manifest for a sandbox instance.
 */
function buildPodSpec(
  podName: string,
  config: SandboxConfig,
  options: {
    image: string;
    namespace: string;
    runtimeClass: string;
    natsUrl: string;
  },
) {
  const [cmd, ...args] = config.command;
  const envVars = canonicalEnv(config);

  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: options.namespace,
      labels: {
        'app.kubernetes.io/name': 'ax-sandbox',
        'app.kubernetes.io/component': 'sandbox',
        'ax.dev/session-id': config.ipcSocket
          .replace(/[^a-zA-Z0-9-_.]/g, '_')  // sanitize invalid chars
          .replace(/^[^a-zA-Z0-9]+/, '')       // strip leading non-alnum
          .replace(/[^a-zA-Z0-9]+$/, '')       // strip trailing non-alnum
          .slice(0, 63) || 'unknown',
      },
    },
    spec: {
      // Only set runtimeClassName when a non-empty class is configured
      ...(options.runtimeClass ? { runtimeClassName: options.runtimeClass } : {}),
      restartPolicy: 'Never',

      // Security: no service account token, no host networking
      automountServiceAccountToken: false,
      hostNetwork: false,

      containers: [
        {
          name: 'sandbox',
          image: options.image,
          command: [cmd, ...args],
          workingDir: CANONICAL.root,

          resources: {
            requests: {
              cpu: DEFAULT_CPU_LIMIT,
              memory: config.memoryMB ? `${config.memoryMB}Mi` : DEFAULT_MEMORY_LIMIT,
            },
            limits: {
              cpu: DEFAULT_CPU_LIMIT,
              memory: config.memoryMB ? `${config.memoryMB}Mi` : DEFAULT_MEMORY_LIMIT,
            },
          },

          securityContext: {
            readOnlyRootFilesystem: true,
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            runAsUser: 1000,
            capabilities: { drop: ['ALL'] },
          },

          env: [
            // NATS connectivity
            { name: 'NATS_URL', value: options.natsUrl },
            // Canonical paths from sandbox config
            ...Object.entries(envVars).map(([name, value]) => ({ name, value })),
            // Pod identity
            { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
          ],

          volumeMounts: [
            { name: 'scratch', mountPath: CANONICAL.scratch },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],

      volumes: [
        { name: 'scratch', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
      ],

      // Timeout: kill the pod after timeoutSec
      activeDeadlineSeconds: config.timeoutSec ?? 600,
    },
  };
}

export async function create(_config: Config): Promise<SandboxProvider> {
  // Lazy import to avoid requiring @kubernetes/client-node when using other sandbox providers
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();

  // Load config — in-cluster when running in k8s, default kubeconfig otherwise
  try {
    kc.loadFromCluster();
    logger.info('k8s_config_loaded', { source: 'in-cluster' });
  } catch {
    kc.loadFromDefault();
    logger.info('k8s_config_loaded', { source: 'kubeconfig' });
  }

  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const watch = new k8s.Watch(kc);

  const image = process.env.K8S_POD_IMAGE ?? DEFAULT_IMAGE;
  const namespace = process.env.K8S_NAMESPACE ?? DEFAULT_NAMESPACE;
  const runtimeClass = process.env.K8S_RUNTIME_CLASS !== undefined
    ? process.env.K8S_RUNTIME_CLASS   // allow empty string to disable
    : DEFAULT_RUNTIME_CLASS;
  const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';

  // Track active pods for cleanup
  const activePods = new Map<number, string>(); // synthetic PID → pod name

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const podName = `ax-sandbox-${randomUUID().slice(0, 8)}`;
      const pid = nextPid++;

      logger.info('creating_pod', { podName, namespace, image });

      const podSpec = buildPodSpec(podName, config, {
        image,
        namespace,
        runtimeClass,
        natsUrl,
      });

      // Create the pod
      try {
        await coreApi.createNamespacedPod({ namespace, body: podSpec });
      } catch (err: unknown) {
        logger.error('pod_create_failed', { podName, error: (err as Error).message });
        throw err;
      }

      activePods.set(pid, podName);

      // Watch pod status for exit code
      const exitCode = new Promise<number>((resolve) => {
        let resolved = false;

        const watchPath = `/api/v1/namespaces/${namespace}/pods`;

        watch.watch(
          watchPath,
          { fieldSelector: `metadata.name=${podName}` },
          (type: string, obj: any) => {
            if (resolved) return;
            const phase = obj?.status?.phase;

            if (phase === 'Succeeded') {
              resolved = true;
              activePods.delete(pid);
              resolve(0);
            } else if (phase === 'Failed') {
              resolved = true;
              activePods.delete(pid);
              // Try to get exit code from container status
              const containerStatus = obj?.status?.containerStatuses?.[0];
              const code = containerStatus?.state?.terminated?.exitCode ?? 1;
              resolve(code);
            }
          },
          (err: any) => {
            if (!resolved) {
              resolved = true;
              activePods.delete(pid);
              logger.warn('pod_watch_error', { podName, error: err?.message });
              resolve(1);
            }
          },
        );

        // Safety timeout: if the pod doesn't complete within activeDeadlineSeconds + buffer
        const timeoutMs = ((config.timeoutSec ?? 600) + 30) * 1000;
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            activePods.delete(pid);
            logger.warn('pod_timeout', { podName, timeoutMs });
            resolve(1);
          }
        }, timeoutMs);
      });

      // Create passthrough streams — in k8s mode, IPC goes over NATS, not stdio.
      // These streams exist to satisfy the SandboxProcess interface but are not
      // the primary communication channel.
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const stdin = new PassThrough();

      // Attach to pod logs (best-effort)
      try {
        const logStream = await coreApi.readNamespacedPodLog({
          name: podName,
          namespace,
          follow: true,
          container: 'sandbox',
        });
        if (logStream && typeof logStream === 'object' && 'pipe' in logStream) {
          (logStream as NodeJS.ReadableStream).pipe(stdout);
        }
      } catch {
        // Pod may not be ready yet — logs will be missed but IPC still works via NATS
      }

      logger.info('pod_created', { podName, pid });

      return {
        pid,
        exitCode,
        stdout,
        stderr,
        stdin,
        kill() {
          // Fire-and-forget pod deletion
          coreApi.deleteNamespacedPod({ name: podName, namespace }).catch((err: any) => {
            logger.warn('pod_delete_failed', { podName, error: err?.message });
          });
          activePods.delete(pid);
        },
      };
    },

    async kill(pid: number): Promise<void> {
      const podName = activePods.get(pid);
      if (!podName) return;

      try {
        await coreApi.deleteNamespacedPod({ name: podName, namespace });
        logger.info('pod_killed', { podName, pid });
      } catch (err: unknown) {
        logger.warn('pod_kill_failed', { podName, pid, error: (err as Error).message });
      }
      activePods.delete(pid);
    },

    async isAvailable(): Promise<boolean> {
      try {
        await coreApi.listNamespacedPod({ namespace, limit: 1 });
        return true;
      } catch {
        return false;
      }
    },
  };
}
