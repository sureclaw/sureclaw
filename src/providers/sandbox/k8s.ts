/**
 * k8s sandbox provider — Kubernetes pod-based isolation.
 *
 * Always cold-starts a new pod. Communication is via HTTP:
 *   - Host delivers work payload via HTTP POST to the pod
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
 *   K8S_IMAGE_PULL_SECRETS — comma-separated secret names for private registries
 */

import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { getLogger } from '../../logger.js';
import { canonicalEnv } from './canonical-paths.js';

const logger = getLogger().child({ component: 'sandbox-k8s' });

const DEFAULT_IMAGE = 'ax/agent:latest';
const DEFAULT_NAMESPACE = 'ax';
const DEFAULT_RUNTIME_CLASS = 'gvisor';
const DEFAULT_CPU_LIMIT = '1';
const DEFAULT_MEMORY_LIMIT = '1Gi';

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
        'app.kubernetes.io/component': 'execution',
        'ax.io/plane': 'execution',
      },
    },
    spec: {
      ...(options.runtimeClass ? { runtimeClassName: options.runtimeClass } : {}),
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      hostNetwork: false,
      ...(process.env.K8S_IMAGE_PULL_SECRETS ? {
        imagePullSecrets: process.env.K8S_IMAGE_PULL_SECRETS.split(',').map(s => ({ name: s.trim() })),
      } : {}),
      initContainers: [
        // Clone repo with --separate-git-dir so .git objects land on /gitdir
        // (a volume mounted ONLY in this init container and the sidecar).
        // The agent container never sees .git metadata.
        // After clone, remove the .git pointer file from /workspace to keep it clean.
        ...(config.extraEnv?.WORKSPACE_REPO_URL ? [{
          name: 'git-init',
          image: options.image,
          ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
          command: [
            'sh', '-c',
            'git clone --separate-git-dir=/gitdir/repo "$WORKSPACE_REPO_URL" /workspace && rm -f /workspace/.git && mkdir -p /workspace/.ax/skills /workspace/.ax/policy',
          ],
          env: [
            { name: 'WORKSPACE_REPO_URL', value: config.extraEnv.WORKSPACE_REPO_URL },
          ],
          securityContext: {
            readOnlyRootFilesystem: false,
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            runAsUser: 1000,
            capabilities: { drop: ['ALL'] },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'gitdir', mountPath: '/gitdir' },
            { name: 'home', mountPath: '/home/user' },
          ],
        }] : []),
        // Git sidecar as native k8s sidecar (init container with restartPolicy: Always).
        // Kubernetes auto-terminates it when the sandbox container exits.
        // Mounts /gitdir (not mounted in sandbox) — agent cannot access .git.
        ...(config.extraEnv?.WORKSPACE_REPO_URL ? [{
          name: 'git-sidecar',
          image: options.image,
          ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
          restartPolicy: 'Always',
          command: ['node', 'dist/agent/git-sidecar.js'],
          resources: {
            requests: { cpu: '50m', memory: '128Mi' },
            limits: { cpu: '200m', memory: '256Mi' },
          },
          securityContext: {
            readOnlyRootFilesystem: false,
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            runAsUser: 1000,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? 'warn' },
            { name: 'AX_WORKSPACE', value: envVars.AX_WORKSPACE || '/workspace' },
            { name: 'AX_GITDIR', value: '/gitdir/repo' },
            { name: 'AX_GIT_SIDECAR_PORT', value: '9099' },
            { name: 'WORKSPACE_REPO_URL', value: config.extraEnv.WORKSPACE_REPO_URL },
          ],
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'gitdir', mountPath: '/gitdir' },
            { name: 'home', mountPath: '/home/user' },
          ],
        }] : []),
      ],
      containers: [
        {
          name: 'sandbox',
          image: options.image,
          ...(process.env.K8S_IMAGE_PULL_POLICY ? { imagePullPolicy: process.env.K8S_IMAGE_PULL_POLICY } : {}),
          command: [cmd, ...args],
          workingDir: '/workspace',
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
            // Writable root: allows npm install, pip install, etc.
            readOnlyRootFilesystem: false,
            allowPrivilegeEscalation: false,
            runAsNonRoot: true,
            runAsUser: 1000,
            capabilities: { drop: ['ALL'] },
          },
          env: [
            // Work comes via HTTP
            { name: 'LOG_LEVEL', value: process.env.K8S_POD_LOG_LEVEL ?? (process.env.AX_VERBOSE === '1' ? 'debug' : 'warn') },
            ...Object.entries(envVars)
              .filter(([k]) => k !== 'AX_IPC_SOCKET' && k !== 'AX_WEB_PROXY_SOCKET')
              .map(([name, value]) => ({ name, value })),
            ...Object.entries(config.extraEnv ?? {})
              .map(([name, value]) => ({ name, value })),
            { name: 'POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            // Sidecar port — agent POSTs to localhost:PORT/turn-complete when turn ends
            ...(config.extraEnv?.WORKSPACE_REPO_URL ? [{ name: 'AX_GIT_SIDECAR_PORT', value: '9099' }] : []),
          ],
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
            { name: 'home', mountPath: '/home/user' },
          ],
        },
      ],
      volumes: [
        // Workspace: agent's working tree (shared between agent + sidecar)
        { name: 'workspace', emptyDir: { sizeLimit: '2Gi' } },
        // Gitdir: .git objects (mounted ONLY in git-init + git-sidecar, NOT in agent)
        { name: 'gitdir', emptyDir: { sizeLimit: '1Gi' } },
        { name: 'tmp', emptyDir: { sizeLimit: '256Mi' } },
        { name: 'home', emptyDir: { sizeLimit: '256Mi' } },
      ],
      // k8s-native safety net: kills the pod even if the host crashes and
      // loses its in-memory idle timers. Uses timeoutSec (24h for session pods,
      // ~10min for per-turn pods) plus a 5-minute buffer.
      activeDeadlineSeconds: (config.timeoutSec ?? 600) + 300,
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
  // Track active pods for cleanup
  const activePods = new Map<number, string>(); // synthetic PID → pod name

  /**
   * Watch a pod for completion and resolve with exit code.
   */
  function watchPodExit(podName: string, pid: number, timeoutSec: number): Promise<number> {
    return new Promise<number>((resolve) => {
      let resolved = false;
      let lastPhase: string | undefined;
      const watchStartTime = Date.now();
      let watchReq: any;

      const watchPath = `/api/v1/namespaces/${namespace}/pods`;

      const cleanup = () => {
        clearTimeout(timer);
        try { watchReq?.abort(); } catch { /* best-effort */ }
      };

      watchReq = watch.watch(
        watchPath,
        { fieldSelector: `metadata.name=${podName}` },
        (type: string, obj: any) => {
          if (resolved) return;
          const phase = obj?.status?.phase;
          lastPhase = phase;

          if (phase === 'Succeeded') {
            resolved = true;
            activePods.delete(pid);
            cleanup();
            resolve(0);
          } else if (phase === 'Failed') {
            resolved = true;
            activePods.delete(pid);
            const containerStatus = obj?.status?.containerStatuses?.[0];
            const code = containerStatus?.state?.terminated?.exitCode ?? 1;
            const reason = containerStatus?.state?.terminated?.reason;
            logger.warn('pod_failed', { podName, exitCode: code, reason, phase });
            cleanup();
            resolve(code);
          }
        },
        (err: any) => {
          if (!resolved) {
            resolved = true;
            activePods.delete(pid);
            logger.warn('pod_watch_error', { podName, lastPhase, error: err?.message });
            cleanup();
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
          logger.warn('pod_timeout', { podName, timeoutMs, lastPhase, elapsedMs: Date.now() - watchStartTime });
          try { watchReq?.abort(); } catch { /* best-effort */ }
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
   * The pod runs runner.js which connects via HTTP and waits for work.
   * No k8s Attach — communication is entirely via HTTP.
   */
  async function spawnCold(config: SandboxConfig): Promise<SandboxProcess> {
    const podName = `ax-sandbox-${randomUUID().slice(0, 8)}`;
    const pid = nextPid++;

    logger.info('creating_pod', { podName, namespace, image });

    // Workspace is managed via git sidecar — no PVC needed

    const podSpec = buildPodSpec(podName, config, {
      image,
      namespace,
      runtimeClass,
    });

    try {
      await coreApi.createNamespacedPod({ namespace, body: podSpec });
    } catch (err: unknown) {
      logger.error('pod_create_failed', { podName, error: (err as Error).message });
      throw err;
    }

    activePods.set(pid, podName);

    const rawExitCode = watchPodExit(podName, pid, config.timeoutSec ?? 600);

    // Self-cleanup: delete the pod after it exits so terminal pods don't accumulate.
    const exitCode = rawExitCode.then(code => {
      coreApi.deleteNamespacedPod({ name: podName, namespace, gracePeriodSeconds: 0 }).catch((err: any) => {
        const status = err?.response?.statusCode;
        if (status !== 404) {
          logger.warn('pod_cleanup_failed', { podName, error: err?.message });
        }
      });
      return code;
    });

    // Dummy streams — response comes via HTTP agent_response, not stdout.
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    stdout.end();
    stderr.end();
    stdin.end();

    // Wait for pod to reach Running (so HTTP work delivery can succeed).
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
      // Always cold start a new pod.
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
