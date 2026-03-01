import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';
import { createCanonicalSymlinks, symlinkEnv } from './canonical-paths.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  const policyPath = resolve('policies/agent.sb');
  const projectDir = resolve('.');

  // Resolve the Node.js install root (handles nvm, fnm, volta, etc.)
  // e.g. ~/.nvm/versions/node/v24.12.0/bin/node → ~/.nvm/versions/node/v24.12.0
  const nodeDir = dirname(dirname(process.execPath));

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;

      // Create symlinks so the agent sees canonical paths (seatbelt can't remap mounts)
      const { mountRoot, cleanup } = createCanonicalSymlinks(config);
      const sEnv = symlinkEnv(config, mountRoot);

      // sandbox-exec with -D parameter substitution for dynamic paths.
      // Seatbelt policy uses REAL host paths for access control (it resolves symlinks).
      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
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
        // Also allow access to symlink mount root
        '-D', `MOUNT_ROOT=${mountRoot}`,
        cmd, ...args,
      ], {
        cwd: sEnv.AX_WORKSPACE,
        env: {
          // Minimal env — canonical symlink paths so the LLM sees simple /workspace-like paths
          PATH: process.env.PATH ?? '/usr/bin:/usr/local/bin',
          HOME: sEnv.AX_WORKSPACE,
          ...sEnv,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec);

      // Clean up symlinks when the process exits
      exitCode.then(() => cleanup(), () => cleanup());

      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return checkCommand('which', ['sandbox-exec']);
    },
  };
}
