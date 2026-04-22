/**
 * Apple Container sandbox provider — lightweight VM-based isolation for macOS.
 *
 * Uses Apple's `container` CLI to run each agent in a dedicated lightweight
 * Linux VM via Virtualization.framework. Key properties:
 *
 * - Per-container VM boundary: stronger isolation than process-level sandboxing
 * - No network by default: containers have no network unless explicitly attached
 * - --read-only root filesystem with writable /tmp
 * - Volume mounts for workspace (rw)
 * - IPC bridge via --publish-socket + virtio-vsock
 * - OCI-compatible images (same images as Docker)
 * - macOS only (Apple Silicon required)
 *
 * IPC uses --publish-socket to bridge Unix sockets across the VM boundary.
 * The agent listens inside the container, and the host connects in via
 * --publish-socket (which tunnels through virtio-vsock). The host MUST wait
 * for the agent's listener to be ready before connecting — the runtime only
 * forwards connections when the container-side listener exists. The agent
 * signals readiness via stderr ("[signal] ipc_ready").
 *
 * The runtime owns the host-side socket and auto-cleans it on container exit,
 * preventing stale socket files.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';
import { CANONICAL, canonicalEnv } from './canonical-paths.js';

const DEFAULT_IMAGE = 'ax/agent:latest';

export async function create(_config: Config): Promise<SandboxProvider> {
  const image = process.env.AX_CONTAINER_IMAGE ?? DEFAULT_IMAGE;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;
      const containerName = `ax-agent-${randomUUID().slice(0, 8)}`;
      const hasIpcSocket = !!config.ipcSocket;

      // IPC bridge: agent listens inside the container on a well-known path,
      // --publish-socket creates a unique host-side socket that tunnels
      // through virtio-vsock into the container. The host connects to the
      // host-side socket after the agent signals readiness. The container
      // runtime owns the host socket and deletes it on exit.
      //
      // Bridge sockets go in a 'bridges/' subdirectory to isolate them from
      // the IPC server's proxy.sock. The container runtime auto-cleans
      // --publish-socket files on exit — if they shared the same directory,
      // aggressive cleanup could remove proxy.sock and break subsequent
      // agent connections.
      const CONTAINER_BRIDGE_SOCK = '/tmp/bridge.sock';
      const ipcSocketDir = hasIpcSocket ? dirname(config.ipcSocket) : '';
      const bridgeDir = hasIpcSocket ? join(ipcSocketDir, 'bridges') : '';
      if (bridgeDir) mkdirSync(bridgeDir, { recursive: true });
      const bridgeSocketPath = hasIpcSocket ? join(bridgeDir, `${containerName}.sock`) : '';

      const containerArgs: string[] = [
        'run',
        '--rm',                                    // auto-remove container on exit
        '-i',                                      // interactive (stdin)
        '--name', containerName,                   // named for debugging
        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', String(config.cpus ?? 1),

        // Filesystem: writable root (no --read-only, no --tmpfs).
        // --publish-socket forwarding fails when the container-side socket path
        // is on a tmpfs mount — the runtime's in-VM forwarding agent resolves
        // paths before tmpfs is applied, so it can't find the agent's listener.
        // TODO: re-enable --read-only once we find a writable non-tmpfs path
        // for the bridge socket (volume mounts don't support Unix sockets).

        // Volume mounts — single /workspace directory (rw)
        '-v', `${config.workspace}:${CANONICAL.root}:rw`,

        // IPC bridge — only for agent containers, not ephemeral tool containers.
        // --publish-socket creates the host-side socket and tunnels connections
        // into the container via virtio-vsock. VirtioFS volume mounts do NOT
        // support Unix domain sockets (connect returns ENOTSUP), so this is
        // the only way to bridge sockets across the VM boundary.
        ...(hasIpcSocket ? ['--publish-socket', `${bridgeSocketPath}:${CONTAINER_BRIDGE_SOCK}`] : []),

        // Working directory — canonical mount root
        '-w', CANONICAL.root,

        // Environment — canonical paths. For agent containers, replace AX_IPC_SOCKET
        // with the container-side bridge socket path (canonicalEnv sets the host path,
        // which doesn't exist inside the VM). Tool containers skip IPC env vars.
        ...Object.entries(canonicalEnv(config))
          .filter(([k]) => hasIpcSocket ? k !== 'AX_IPC_SOCKET' : k !== 'AX_IPC_SOCKET')
          .flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        ...(hasIpcSocket ? [
          '-e', `AX_IPC_SOCKET=${CONTAINER_BRIDGE_SOCK}`,
          // Tell the agent to listen (accept connections) instead of connecting out
          '-e', 'AX_IPC_LISTEN=1',
        ] : []),
        // Per-turn extra env (credential placeholders, CA trust, etc.)
        ...Object.entries(config.extraEnv ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        // Chat-turn correlation ID — agent runner binds `reqId` so agent logs
        // join the host + sandbox provider lifecycle on a single grep.
        ...(config.requestId ? ['-e', `AX_REQUEST_ID=${config.requestId}`] : []),
      ];

      containerArgs.push(image, cmd, ...args);

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn('container', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec, 5);
      return {
        ...sandboxProcess(child, exitCode),
        ...(hasIpcSocket ? { bridgeSocketPath } : {}),
      };
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      if (process.platform !== 'darwin') return false;
      return checkCommand('container', ['--help']);
    },
  };
}
