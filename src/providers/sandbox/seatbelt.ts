import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  const policyPath = resolve('policies/agent.sb');
  const projectDir = resolve('.');

  // Resolve the Node.js install root (handles nvm, fnm, volta, etc.)
  // e.g. ~/.nvm/versions/node/v24.12.0/bin/node → ~/.nvm/versions/node/v24.12.0
  const nodeDir = dirname(dirname(process.execPath));

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;

      // sandbox-exec with -D parameter substitution for dynamic paths
      const child = spawn('sandbox-exec', [
        '-f', policyPath,
        '-D', `WORKSPACE=${config.workspace}`,
        '-D', `SKILLS=${config.skills}`,
        '-D', `IPC_SOCKET_DIR=${dirname(config.ipcSocket)}`,
        '-D', `PROJECT_DIR=${projectDir}`,
        '-D', `NODE_DIR=${nodeDir}`,
        '-D', `AGENT_DIR=${config.agentDir ?? config.workspace}`,
        '-D', `AGENT_WORKSPACE=${config.agentWorkspace ?? ''}`,
        '-D', `USER_WORKSPACE=${config.userWorkspace ?? ''}`,
        '-D', `SCRATCH_DIR=${config.scratchDir ?? ''}`,
        cmd, ...args,
      ], {
        cwd: config.workspace,
        env: {
          // Minimal env — no credentials leak into the sandbox
          PATH: process.env.PATH ?? '/usr/bin:/usr/local/bin',
          HOME: config.workspace,
          AX_IPC_SOCKET: config.ipcSocket,
          AX_WORKSPACE: config.workspace,
          AX_SKILLS: config.skills,
          ...(config.agentWorkspace ? { AX_AGENT_WORKSPACE: config.agentWorkspace } : {}),
          ...(config.userWorkspace ? { AX_USER_WORKSPACE: config.userWorkspace } : {}),
          ...(config.scratchDir ? { AX_SCRATCH: config.scratchDir } : {}),
          // Redirect caches and data dirs so they don't pollute the workspace
          npm_config_cache: '/tmp/.ax-npm-cache',
          XDG_CACHE_HOME: '/tmp/.ax-cache',
          AX_HOME: '/tmp/.ax-agent',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec);
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return checkCommand('which', ['sandbox-exec']);
    },
  };
}
