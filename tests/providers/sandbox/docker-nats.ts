/**
 * docker-nats sandbox provider — Docker container with NATS/HTTP IPC.
 *
 * Hybrid of the Docker sandbox (container isolation, security hardening)
 * and the k8s communication path (NATS work delivery, HTTP IPC).
 * Uses Docker bridge network + host.docker.internal to reach NATS and
 * the host's HTTP endpoints, simulating the k8s pod environment without
 * needing a real cluster.
 *
 * Test-only — not a production provider.
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from '../../../src/providers/sandbox/types.js';
import type { Config } from '../../../src/types.js';
import { exitCodePromise, enforceTimeout, killProcess } from '../../../src/providers/sandbox/utils.js';
import { CANONICAL, canonicalEnv } from '../../../src/providers/sandbox/canonical-paths.js';

const DEFAULT_IMAGE = 'ax/agent:e2e-test';
const DEFAULT_PID_LIMIT = 256;

export interface DockerNATSOptions {
  /** Host URL the container should use for HTTP IPC (e.g. http://host.docker.internal:18123). */
  hostUrl: string;
  /** NATS URL the container should use (e.g. nats://host.docker.internal:4222). */
  natsUrl?: string;
}

export async function create(_config: Config, opts: DockerNATSOptions): Promise<SandboxProvider> {
  const image = process.env.AX_DOCKER_IMAGE ?? DEFAULT_IMAGE;
  const natsUrl = opts.natsUrl ?? 'nats://host.docker.internal:4222';
  const hostUrl = opts.hostUrl;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const podName = `docker-nats-${randomUUID().slice(0, 8)}`;
      const containerName = `ax-agent-${randomUUID().slice(0, 8)}`;

      // Build canonical env vars, then remove AX_IPC_SOCKET (using HTTP IPC, not Unix socket)
      const env = canonicalEnv(config);
      delete env.AX_IPC_SOCKET;

      const dockerArgs: string[] = [
        'run',
        '--rm',
        '-i',
        '--name', containerName,

        // Bridge network + host gateway (container can reach NATS + host HTTP)
        '--add-host=host.docker.internal:host-gateway',

        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', String(config.cpus ?? 1),
        '--pids-limit', String(DEFAULT_PID_LIMIT),

        // Security hardening (matches k8s pod spec)
        '--cap-drop=ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
        '--user', '1000:1000',

        // Volume mounts — single /workspace directory (rw)
        '-v', `${config.workspace}:${CANONICAL.root}:rw`,

        // Working directory
        '-w', CANONICAL.root,

        // Environment — canonical paths (minus IPC socket)
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),

        // NATS + HTTP IPC environment (k8s mode)
        '-e', `NATS_URL=${natsUrl}`,
        '-e', `POD_NAME=${podName}`,
        '-e', `AX_HOST_URL=${hostUrl}`,
        '-e', `LOG_LEVEL=${process.env.LOG_LEVEL ?? 'warn'}`,

        // Per-turn extra env vars (IPC token, request ID, etc.)
        ...Object.entries(config.extraEnv ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ];

      // Timeout
      if (config.timeoutSec) {
        dockerArgs.push('--stop-timeout', String(config.timeoutSec));
      }

      const [cmd, ...args] = config.command;
      dockerArgs.push(image, cmd, ...args);

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec, 5);

      // Pipe stderr to parent for debugging visibility
      child.stderr?.pipe(process.stderr);

      return {
        pid: child.pid!,
        exitCode,
        stdout: child.stdout!,
        stderr: child.stderr!,
        stdin: child.stdin!,
        kill() { child.kill(); },
        // podName triggers the host's NATS work delivery code path
        podName,
      };
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      try {
        execFileSync('docker', ['info'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
