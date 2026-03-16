/**
 * k8s sandbox provider — Kubernetes pod-based isolation.
 *
 * Supports two modes:
 *   1. Cold start (default): Creates a new pod for each sandbox request.
 *   2. Warm pool (WARM_POOL_ENABLED=true): Claims a pre-warmed pod from the
 *      pool controller, then execs the agent command inside it. Falls back
 *      to cold start if no warm pods are available.
 *
 * Warm pool pods run a standby entrypoint (sleep) and wait for work.
 * When claimed, the host uses the k8s Exec API to start the agent with
 * the correct environment variables — no pod creation latency.
 *
 * Communication: stdin/stdout are connected via the k8s Attach API (cold)
 * or Exec API (warm). The host writes the conversation payload to stdin
 * and reads the agent response from stdout.
 *
 * Environment:
 *   K8S_NAMESPACE — target namespace (default: "ax")
 *   K8S_POD_IMAGE — container image (default: "ax/agent:latest")
 *   K8S_RUNTIME_CLASS — runtime class name (default: "gvisor")
 *   NATS_URL — NATS server URL passed to sandbox pods
 *   WARM_POOL_ENABLED — enable warm pool claiming (default: false)
 *   WARM_POOL_TIER — tier to claim from (default: "light")
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

      containers: [
        {
          name: 'sandbox',
          image: options.image,
          command: [cmd, ...args],
          workingDir: CANONICAL.root,
          stdin: true,

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
            // Use NATS for IPC instead of Unix sockets (pods can't share host filesystem)
            { name: 'AX_IPC_TRANSPORT', value: 'nats' },
            // Suppress agent debug/info logs — pod logs are piped into the
            // SandboxProcess.stdout stream which becomes the HTTP response.
            // Without this, pino JSON lines pollute the response content.
            { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? 'warn' },
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

/**
 * Build the env + command array for k8s exec into a warm pod.
 *
 * Uses `env` to inject per-turn environment variables, then execs the
 * agent command. This lets us reuse warm pods that were created with
 * base env (NATS, canonical paths) while adding request-specific vars.
 */
export function buildExecCommand(
  config: SandboxConfig,
  natsUrl: string,
): string[] {
  const envVars = canonicalEnv(config);

  // Build KEY=VALUE pairs for env command
  const envPairs: string[] = [];

  // Canonical paths (skip AX_IPC_SOCKET — using NATS)
  for (const [key, value] of Object.entries(envVars)) {
    if (key !== 'AX_IPC_SOCKET') {
      envPairs.push(`${key}=${value}`);
    }
  }

  // Per-turn extra env vars (IPC token, request ID, etc.)
  for (const [key, value] of Object.entries(config.extraEnv ?? {})) {
    envPairs.push(`${key}=${value}`);
  }

  // NATS sandbox credentials (if set on host)
  if (process.env.NATS_SANDBOX_PASS) {
    envPairs.push('NATS_USER=sandbox');
    envPairs.push(`NATS_PASS=${process.env.NATS_SANDBOX_PASS}`);
  }

  // IPC transport
  envPairs.push('AX_IPC_TRANSPORT=nats');
  envPairs.push(`NATS_URL=${natsUrl}`);
  envPairs.push(`LOG_LEVEL=${process.env.K8S_POD_LOG_LEVEL ?? 'warn'}`);

  // Final command: env KEY=VAL ... <agent-command>
  return ['env', ...envPairs, ...config.command];
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
  const attach = new k8s.Attach(kc);
  const exec = new k8s.Exec(kc);
  const watch = new k8s.Watch(kc);

  const image = process.env.K8S_POD_IMAGE ?? DEFAULT_IMAGE;
  const namespace = process.env.K8S_NAMESPACE ?? DEFAULT_NAMESPACE;
  const runtimeClass = process.env.K8S_RUNTIME_CLASS !== undefined
    ? process.env.K8S_RUNTIME_CLASS   // allow empty string to disable
    : DEFAULT_RUNTIME_CLASS;
  const natsUrl = process.env.NATS_URL ?? 'nats://nats:4222';

  // Warm pool config
  const warmPoolEnabled = process.env.WARM_POOL_ENABLED === 'true';
  const warmPoolTier = process.env.WARM_POOL_TIER ?? 'light';

  // Lazy-init warm pool client (only when warm pool is enabled)
  let warmPoolClient: import('./warm-pool-client.js').WarmPoolClient | null = null;
  if (warmPoolEnabled) {
    const { createWarmPoolClient } = await import('./warm-pool-client.js');
    warmPoolClient = await createWarmPoolClient(namespace);
    logger.info('warm_pool_enabled', { tier: warmPoolTier, namespace });
  }

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

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    // Wait for pod to reach Running, then attach stdin/stdout via WebSocket.
    (async () => {
      try {
        for (let i = 0; i < 120; i++) {
          const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
          const phase = (pod as any)?.status?.phase;
          if (phase === 'Running') break;
          if (phase === 'Failed' || phase === 'Succeeded') {
            logger.warn('pod_ended_before_attach', { podName, phase });
            stdout.end();
            stderr.end();
            return;
          }
          await new Promise(r => setTimeout(r, 500));
        }

        logger.info('attaching_to_pod', { podName });
        await attach.attach(namespace, podName, 'sandbox', stdout, stderr, stdin, false);
        logger.info('pod_attached', { podName });
      } catch (err: unknown) {
        logger.warn('pod_attach_failed', { podName, error: (err as Error).message });
        stdout.end();
        stderr.end();
      }
    })();

    logger.info('pod_created', { podName, pid });

    return {
      pid,
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

  /**
   * Warm-start path: claim a pre-warmed pod and exec the agent inside it.
   *
   * The warm pod is running a standby entrypoint (sleep). We use the k8s
   * Exec API to start the agent with the correct env vars. The exec'd
   * process gets its own stdin/stdout connected via WebSocket.
   */
  async function spawnWarm(config: SandboxConfig): Promise<SandboxProcess | null> {
    if (!warmPoolClient) return null;

    const claimed = await warmPoolClient.claimPod(warmPoolTier);
    if (!claimed) {
      logger.info('warm_pool_miss', { tier: warmPoolTier });
      return null;
    }

    const podName = claimed.name;
    const pid = nextPid++;

    logger.info('warm_pod_claimed', { podName, tier: claimed.tier, pid });

    activePods.set(pid, podName);

    // Build exec command with per-turn env vars
    const execCommand = buildExecCommand(config, natsUrl);

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();

    // Delete the claimed pod (fire-and-forget). Called from every
    // completion path so claimed pods don't accumulate as zombies.
    function releaseClaimedPod() {
      coreApi.deleteNamespacedPod({ name: podName, namespace }).catch((err: any) => {
        logger.warn('warm_pod_release_failed', { podName, error: err?.message });
      });
    }

    // The k8s Exec exit resolves when the command inside the pod finishes.
    // Every resolution path also deletes the claimed pod.
    const execDone = new Promise<number>((resolve) => {
      let resolved = false;

      // Start k8s Exec — the agent runs as a child of the standby entrypoint.
      // Note: this is the k8s Exec API (not child_process.exec).
      exec.exec(
        namespace,
        podName,
        'sandbox',
        execCommand,
        stdout,
        stderr,
        stdin,
        false, // tty
        (status: any) => {
          if (resolved) return;
          resolved = true;
          activePods.delete(pid);
          releaseClaimedPod();

          // status is a k8s V1Status object
          const exitCode = status?.status === 'Success' ? 0 : 1;
          resolve(exitCode);
        },
      ).catch((err: unknown) => {
        if (!resolved) {
          resolved = true;
          activePods.delete(pid);
          releaseClaimedPod();
          logger.warn('warm_exec_failed', { podName, error: (err as Error).message });
          resolve(1);
        }
      });

      // Safety timeout
      const timeoutMs = ((config.timeoutSec ?? 600) + 30) * 1000;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          activePods.delete(pid);
          releaseClaimedPod();
          logger.warn('warm_exec_timeout', { podName, timeoutMs });
          resolve(1);
        }
      }, timeoutMs);
      if (timer.unref) timer.unref();
    });

    return {
      pid,
      exitCode: execDone,
      stdout,
      stderr,
      stdin,
      kill() {
        // Delete the whole pod — the exec'd process dies with it
        coreApi.deleteNamespacedPod({ name: podName, namespace }).catch((err: any) => {
          logger.warn('warm_pod_delete_failed', { podName, error: err?.message });
        });
        activePods.delete(pid);
      },
    };
  }

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      // Try warm pool first, fall back to cold start
      if (warmPoolEnabled) {
        const warmResult = await spawnWarm(config);
        if (warmResult) return warmResult;
        logger.info('warm_pool_fallback_cold', { tier: warmPoolTier });
      }

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
