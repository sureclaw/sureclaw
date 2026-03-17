/**
 * k8s sandbox provider — Kubernetes pod-based isolation.
 *
 * Always cold-starts a new pod. Warm pool claiming is handled at the NATS
 * queue group level — the host's publishWork() uses nc.request('sandbox.work')
 * to deliver work to warm pods via queue groups before falling back to
 * cold-starting a pod here.
 *
 * Communication is via NATS (work dispatch) and HTTP (IPC, LLM proxy,
 * workspace release):
 *   - Host publishes work payload via NATS queue group or per-pod subject
 *   - Agent sends IPC requests via HTTP to /internal/ipc
 *   - Agent sends response via agent_response IPC action
 *
 * No k8s Exec or Attach API — eliminates stdin/stdout complexity and
 * log pollution issues.
 *
 * Environment:
 *   K8S_NAMESPACE — target namespace (default: "ax")
 *   K8S_POD_IMAGE — container image (default: "ax/agent:latest")
 *   K8S_RUNTIME_CLASS — runtime class name (default: "gvisor")
 *   NATS_URL — NATS server URL passed to sandbox pods
 *   K8S_IMAGE_PULL_SECRETS — comma-separated secret names for private registries
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
 * Build a k8s pod manifest for a sandbox instance (cold-start path).
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

      // Private registry credentials
      ...(process.env.K8S_IMAGE_PULL_SECRETS ? {
        imagePullSecrets: process.env.K8S_IMAGE_PULL_SECRETS.split(',').map(s => ({ name: s.trim() })),
      } : {}),

      containers: [
        {
          name: 'sandbox',
          image: options.image,
          ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
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
            // NATS sandbox user credentials (static auth)
            ...(process.env.NATS_SANDBOX_PASS ? [
              { name: 'NATS_USER', value: 'sandbox' },
              { name: 'NATS_PASS', value: process.env.NATS_SANDBOX_PASS },
            ] : []),
            // Use HTTP for IPC instead of Unix sockets (pods can't share host filesystem)
            { name: 'AX_IPC_TRANSPORT', value: 'http' },
            // Suppress agent debug/info logs — pod logs are piped into the
            // SandboxProcess.stdout stream which becomes the HTTP response.
            // Without this, pino JSON lines pollute the response content.
            { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? (process.env.AX_VERBOSE === '1' ? 'debug' : 'warn') },
            // Canonical paths from sandbox config (filter out AX_IPC_SOCKET — using NATS instead)
            ...Object.entries(envVars)
              .filter(([k]) => k !== 'AX_IPC_SOCKET')
              .map(([name, value]) => ({ name, value })),
            // Per-turn extra env vars (IPC token, request ID, etc.)
            ...Object.entries(config.extraEnv ?? {})
              .map(([name, value]) => ({ name, value })),
            // Pod identity
            { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
          ],

          volumeMounts: [
            { name: 'scratch', mountPath: CANONICAL.scratch },
            { name: 'tmp', mountPath: '/tmp' },
            { name: 'agent-ws', mountPath: CANONICAL.agent },
            { name: 'user-ws', mountPath: CANONICAL.user },
          ],
        },
      ],

      volumes: [
        { name: 'scratch', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
        { name: 'agent-ws', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'user-ws', emptyDir: { sizeLimit: '1Gi' } },
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

  /**
   * Watch a pod for completion and resolve with exit code.
   */
  function watchPodExit(podName: string, pid: number, timeoutSec: number): Promise<number> {
    return new Promise<number>((resolve) => {
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

      // Safety timeout
      const timeoutMs = (timeoutSec + 30) * 1000;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          activePods.delete(pid);
          logger.warn('pod_timeout', { podName, timeoutMs });
          resolve(1);
        }
      }, timeoutMs);
      // Prevent timer from keeping the process alive
      if (timer.unref) timer.unref();
    });
  }

  /**
   * Cold-start path: create a new pod from scratch.
   *
   * The pod runs runner.js which connects to NATS and waits for work.
   * No k8s Attach — communication is entirely via NATS.
   */
  async function spawnCold(config: SandboxConfig): Promise<SandboxProcess> {
    const podName = `ax-sandbox-${randomUUID().slice(0, 8)}`;
    const pid = nextPid++;

    logger.info('creating_pod', { podName, namespace, image });

    const podSpec = buildPodSpec(podName, config, {
      image,
      namespace,
      runtimeClass,
      natsUrl,
    });

    try {
      await coreApi.createNamespacedPod({ namespace, body: podSpec });
    } catch (err: unknown) {
      logger.error('pod_create_failed', { podName, error: (err as Error).message });
      throw err;
    }

    activePods.set(pid, podName);

    const exitCode = watchPodExit(podName, pid, config.timeoutSec ?? 600);

    // Dummy streams — response comes via NATS agent_response, not stdout.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdout.end();
    stderr.end();
    stdin.end();

    // Wait for pod to reach Running (so NATS work delivery can succeed).
    (async () => {
      try {
        for (let i = 0; i < 120; i++) {
          const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
          const phase = (pod as any)?.status?.phase;
          if (phase === 'Running') {
            logger.info('pod_running', { podName });
            break;
          }
          if (phase === 'Failed' || phase === 'Succeeded') {
            logger.warn('pod_ended_before_running', { podName, phase });
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err: unknown) {
        logger.warn('pod_status_check_failed', { podName, error: (err as Error).message });
      }
    })();

    logger.info('pod_created', { podName, pid });

    return {
      pid,
      podName,
      exitCode,
      stdout,
      stderr,
      stdin,
      kill() {
        coreApi.deleteNamespacedPod({ name: podName, namespace }).catch((err: any) => {
          logger.warn('pod_delete_failed', { podName, error: err?.message });
        });
        activePods.delete(pid);
      },
    };
  }

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      // Always cold start — warm pool claiming is now handled by NATS queue groups
      // (the host's publishWork uses nc.request('sandbox.work') before calling spawn).
      return spawnCold(config);
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
