import { spawn } from 'node:child_process';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, sandboxProcess } from './utils.js';
import { getLogger } from '../../logger.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  let warned = false;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      if (!warned) {
        getLogger().warn('no_isolation', { message: 'dev-only fallback — no sandbox isolation' });
        warned = true;
      }

      const [cmd, ...args] = config.command;
      const child = spawn(cmd, args, {
        cwd: config.workspace,
        env: {
          ...process.env,
          AX_IPC_SOCKET: config.ipcSocket,
          AX_WORKSPACE: config.workspace,
          AX_SKILLS: config.skills,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec);
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return true; // Always available — it's just a subprocess
    },
  };
}
