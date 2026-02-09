/**
 * nsjail sandbox provider — Linux namespaces + seccomp-bpf isolation.
 *
 * Uses nsjail with:
 * - clone_newnet: NO network access (security invariant)
 * - Bind-mounts: workspace (rw), skills (ro), IPC socket
 * - Seccomp-bpf policy via Kafel language (policies/agent.kafel)
 * - Memory and time limits enforced at kernel level
 */

import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess, Config } from '../types.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  const policyPath = resolve('policies/agent.kafel');

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;

      const nsjailArgs: string[] = [
        // Isolation
        '--mode', 'o',                          // once mode (exit after child exits)
        '--clone_newnet',                        // NO network access
        '--clone_newuser',                       // user namespace
        '--clone_newpid',                        // PID namespace
        '--clone_newipc',                        // IPC namespace

        // Resource limits
        '--time_limit', String(config.timeoutSec ?? 30),
        '--rlimit_as', String(config.memoryMB ?? 256),
        '--max_cpus', '1',

        // Mount workspace (read-write)
        '--bindmount', `${config.workspace}:${config.workspace}`,
        '--cwd', config.workspace,

        // Mount skills (read-only)
        '--bindmount_ro', `${config.skills}:${config.skills}`,

        // Mount IPC socket directory
        '--bindmount', `${resolve(config.ipcSocket, '..')}:${resolve(config.ipcSocket, '..')}`,

        // Mount essentials (read-only)
        '--bindmount_ro', '/usr:/usr',
        '--bindmount_ro', '/lib:/lib',
        '--bindmount_ro', '/lib64:/lib64',
        '--bindmount_ro', '/etc/resolv.conf:/etc/resolv.conf',

        // Mount Node.js (read-only) — detect from current process
        '--bindmount_ro', `${resolve(process.execPath, '../..')}:${resolve(process.execPath, '../..')}`,

        // Seccomp-bpf policy
        '--seccomp_policy', policyPath,

        // Minimal env
        '--env', `PATH=${process.env.PATH ?? '/usr/bin:/usr/local/bin'}`,
        '--env', `HOME=${config.workspace}`,
        '--env', `SURECLAW_IPC_SOCKET=${config.ipcSocket}`,
        '--env', `SURECLAW_WORKSPACE=${config.workspace}`,
        '--env', `SURECLAW_SKILLS=${config.skills}`,

        // Command
        '--', cmd, ...args,
      ];

      const child = spawn('nsjail', nsjailArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = new Promise<number>((resolve, reject) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', reject);
      });

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
        execFileSync('which', ['nsjail'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
