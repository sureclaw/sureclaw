/**
 * nsjail sandbox provider — Linux namespaces + seccomp-bpf isolation.
 *
 * Uses nsjail with:
 * - clone_newnet: NO network access (security invariant)
 * - Bind-mounts: workspace (rw), IPC socket
 * - Seccomp-bpf policy via Kafel language (policies/agent.kafel)
 * - Memory and time limits enforced at kernel level
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, killProcess, checkCommand, sandboxProcess } from './utils.js';
import { CANONICAL, canonicalEnv } from './canonical-paths.js';

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

        // Mount workspace (read-write) — canonical /scratch
        '--bindmount', `${config.workspace}:${CANONICAL.scratch}`,
        '--cwd', CANONICAL.root,

        // Enterprise mounts — canonical paths
        ...(config.agentWorkspace ? ['--bindmount_ro', `${config.agentWorkspace}:${CANONICAL.agent}`] : []),
        ...(config.userWorkspace ? ['--bindmount_ro', `${config.userWorkspace}:${CANONICAL.user}`] : []),

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

        // Minimal env — canonical paths so the LLM sees simple /scratch
        '--env', `PATH=${process.env.PATH ?? '/usr/bin:/usr/local/bin'}`,
        '--env', `HOME=${CANONICAL.root}`,
        ...Object.entries(canonicalEnv(config)).flatMap(([k, v]) => ['--env', `${k}=${v}`]),

        // Command
        '--', cmd, ...args,
      ];

      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
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
