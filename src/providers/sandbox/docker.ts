/**
 * Docker sandbox provider — container-based isolation.
 *
 * Uses Docker with:
 * - --network=none: NO network access (security invariant)
 * - --memory + --pids-limit: resource limits
 * - --read-only: immutable root filesystem (writable /tmp)
 * - --cap-drop=ALL: drop all Linux capabilities
 * - Volume mounts: workspace (rw), skills (ro), IPC socket
 * - Optional gVisor runtime (--runtime=runsc) for strong syscall filtering
 * - Named containers for debuggability (ax-agent-<short-uuid>)
 * - Works on Linux and macOS (Docker Desktop)
 */

import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';

const DEFAULT_IMAGE = 'ax/agent:latest';
const DEFAULT_PID_LIMIT = 256;

function isGVisorAvailable(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.Runtimes}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    // Check if runsc runtime is listed
    const output = execFileSync('docker', ['info', '--format', '{{json .Runtimes}}'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    });
    return output.includes('runsc');
  } catch {
    return false;
  }
}

export async function create(_config: Config): Promise<SandboxProvider> {
  const image = process.env.AX_DOCKER_IMAGE ?? DEFAULT_IMAGE;
  const runtimeEnv = process.env.AX_DOCKER_RUNTIME;
  const useGVisor = runtimeEnv === 'gvisor';

  // Warn at create time if gVisor requested but not available
  if (useGVisor && !isGVisorAvailable()) {
    const { getLogger } = await import('../../logger.js');
    getLogger().warn('gvisor_not_found', {
      message: 'gVisor runtime requested but runsc not found',
      installUrl: 'https://gvisor.dev/docs/user_guide/install/',
    });
  }

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;
      const socketDir = resolve(config.ipcSocket, '..');
      const containerName = `ax-agent-${randomUUID().slice(0, 8)}`;

      const dockerArgs: string[] = [
        'run',
        '--rm',                                    // auto-remove container on exit
        '-i',                                      // interactive (stdin)
        '--name', containerName,                   // named for debugging
        '--network=none',                          // NO network access

        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', '1',
        '--pids-limit', String(DEFAULT_PID_LIMIT), // limit process count

        // Security hardening
        '--cap-drop=ALL',
        '--security-opt', 'no-new-privileges',
        '--read-only',                             // immutable root fs
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', // writable /tmp

        // Volume mounts
        '-v', `${config.workspace}:${config.workspace}:rw`,
        '-v', `${config.skills}:${config.skills}:ro`,
        '-v', `${socketDir}:${socketDir}:rw`,

        // Working directory
        '-w', config.workspace,

        // Environment
        '-e', `AX_IPC_SOCKET=${config.ipcSocket}`,
        '-e', `AX_WORKSPACE=${config.workspace}`,
        '-e', `AX_SKILLS=${config.skills}`,
      ];

      // Optional gVisor runtime for stronger isolation
      if (useGVisor) {
        dockerArgs.push('--runtime=runsc');
      }

      // Timeout via --stop-timeout (Docker kills container after this)
      if (config.timeoutSec) {
        dockerArgs.push('--stop-timeout', String(config.timeoutSec));
      }

      // Image and command
      dockerArgs.push(image, cmd, ...args);

      const child = spawn('docker', dockerArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec, 5); // +5s grace for Docker cleanup
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return checkCommand('docker', ['info']);
    },
  };
}
