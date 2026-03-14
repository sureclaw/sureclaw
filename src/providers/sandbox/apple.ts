/**
 * Apple Container sandbox provider — lightweight VM-based isolation for macOS.
 *
 * Uses Apple's `container` CLI to run each agent in a dedicated lightweight
 * Linux VM via Virtualization.framework. Key properties:
 *
 * - Per-container VM boundary: stronger isolation than process-level sandboxing
 * - No network by default: containers have no network unless explicitly attached
 * - --read-only root filesystem with writable /tmp
 * - Volume mounts for workspace (rw) and IPC socket
 * - --publish-socket for Unix socket forwarding (Apple Container-specific)
 * - OCI-compatible images (same images as Docker)
 * - macOS only (Apple Silicon required)
 */

import { spawn } from 'node:child_process';
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

      const containerArgs: string[] = [
        'run',
        '--rm',                                    // auto-remove container on exit
        '-i',                                      // interactive (stdin)
        '--name', containerName,                   // named for debugging
        // No --network flag: Apple Container has no network by default.
        // Each container runs in its own VM — no shared kernel, no network
        // unless explicitly attached. This satisfies the security invariant.

        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', '1',

        // Filesystem hardening
        '--read-only',                             // immutable root fs
        '--tmpfs', '/tmp',                         // writable /tmp

        // Volume mounts — canonical paths so the LLM sees simple /scratch
        '-v', `${config.workspace}:${CANONICAL.scratch}:rw`,

        // IPC socket — use --publish-socket for Unix socket forwarding
        '--publish-socket', `${config.ipcSocket}:${config.ipcSocket}`,

        // Enterprise mounts — canonical paths
        ...(config.agentWorkspace ? ['-v', `${config.agentWorkspace}:${CANONICAL.agent}:ro`] : []),
        ...(config.userWorkspace ? ['-v', `${config.userWorkspace}:${CANONICAL.user}:ro`] : []),

        // Working directory — canonical mount root
        '-w', CANONICAL.root,

        // Environment — canonical paths
        ...Object.entries(canonicalEnv(config)).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      ];

      // Image and command
      containerArgs.push(image, cmd, ...args);

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn('container', containerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec, 5);
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      if (process.platform !== 'darwin') return false;
      return checkCommand('container', ['--help']);
    },
  };
}
