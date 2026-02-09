/**
 * Docker sandbox provider — container-based isolation.
 *
 * Uses Docker with:
 * - --network=none: NO network access (security invariant)
 * - --memory: memory limits
 * - Volume mounts: workspace (rw), skills (ro), IPC socket
 * - Optional gVisor runtime (--runtime=runsc) for strong syscall filtering
 * - Works on Linux and macOS (Docker Desktop)
 */

import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess, Config } from '../types.js';

const DEFAULT_IMAGE = 'sureclaw/agent:latest';

export async function create(_config: Config): Promise<SandboxProvider> {
  const image = process.env.SURECLAW_DOCKER_IMAGE ?? DEFAULT_IMAGE;
  const useGVisor = process.env.SURECLAW_DOCKER_RUNTIME === 'gvisor';

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;
      const socketDir = resolve(config.ipcSocket, '..');

      const dockerArgs: string[] = [
        'run',
        '--rm',                                    // auto-remove container on exit
        '-i',                                      // interactive (stdin)
        '--network=none',                          // NO network access

        // Resource limits
        '--memory', `${config.memoryMB ?? 256}m`,
        '--cpus', '1',

        // Security: drop all capabilities, no new privileges
        '--cap-drop=ALL',
        '--security-opt', 'no-new-privileges',

        // Volume mounts
        '-v', `${config.workspace}:${config.workspace}:rw`,
        '-v', `${config.skills}:${config.skills}:ro`,
        '-v', `${socketDir}:${socketDir}:rw`,

        // Working directory
        '-w', config.workspace,

        // Environment
        '-e', `SURECLAW_IPC_SOCKET=${config.ipcSocket}`,
        '-e', `SURECLAW_WORKSPACE=${config.workspace}`,
        '-e', `SURECLAW_SKILLS=${config.skills}`,
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

      const exitCode = new Promise<number>((resolve, reject) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', reject);
      });

      // Enforce timeout at host level too (belt and suspenders)
      if (config.timeoutSec) {
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, (config.timeoutSec + 5) * 1000); // +5s grace for Docker cleanup
      }

      return {
        pid: child.pid!,
        exitCode,
        stdout: child.stdout,
        stderr: child.stderr,
        stdin: child.stdin,
        kill() { child.kill(); },
      };
    },

    async kill(pid: number): Promise<void> {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process already exited
      }
    },

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
