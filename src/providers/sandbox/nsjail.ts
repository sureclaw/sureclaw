/**
 * nsjail sandbox provider — Linux namespaces + seccomp-bpf isolation.
 *
 * Uses nsjail with:
 * - clone_newnet: NO network access (security invariant)
 * - Bind-mounts: workspace (rw), skills (ro), IPC socket
 * - Seccomp-bpf policy via Kafel language (policies/agent.kafel)
 * - Memory and time limits enforced at kernel level
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, killProcess, checkCommand, sandboxProcess } from './utils.js';

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

        // Mount agent identity directory (read-only) — SOUL.md, BOOTSTRAP.md, etc.
        ...(config.agentDir ? ['--bindmount_ro', `${config.agentDir}:${config.agentDir}`] : []),

        // Enterprise three-tier mounts
        ...(config.agentWorkspace ? ['--bindmount_ro', `${config.agentWorkspace}:${config.agentWorkspace}`] : []),
        ...(config.userWorkspace ? ['--bindmount', `${config.userWorkspace}:${config.userWorkspace}`] : []),
        ...(config.scratchDir ? ['--bindmount', `${config.scratchDir}:${config.scratchDir}`] : []),

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
        '--env', `AX_IPC_SOCKET=${config.ipcSocket}`,
        '--env', `AX_WORKSPACE=${config.workspace}`,
        '--env', `AX_SKILLS=${config.skills}`,
        ...(config.agentWorkspace ? ['--env', `AX_AGENT_WORKSPACE=${config.agentWorkspace}`] : []),
        ...(config.userWorkspace ? ['--env', `AX_USER_WORKSPACE=${config.userWorkspace}`] : []),
        ...(config.scratchDir ? ['--env', `AX_SCRATCH=${config.scratchDir}`] : []),
        // Redirect caches and data dirs so they don't pollute the workspace
        '--env', 'npm_config_cache=/tmp/.ax-npm-cache',
        '--env', 'XDG_CACHE_HOME=/tmp/.ax-cache',
        '--env', 'AX_HOME=/tmp/.ax-agent',

        // Command
        '--', cmd, ...args,
      ];

      const child = spawn('nsjail', nsjailArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return checkCommand('which', ['nsjail']);
    },
  };
}
