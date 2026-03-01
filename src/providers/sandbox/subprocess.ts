import { spawn } from 'node:child_process';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, sandboxProcess } from './utils.js';
import { getLogger } from '../../logger.js';
import { createCanonicalSymlinks, symlinkEnv } from './canonical-paths.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  let warned = false;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      if (!warned) {
        getLogger().warn('no_isolation', { message: 'dev-only fallback — no sandbox isolation' });
        warned = true;
      }

      // Create symlinks so the agent sees canonical paths (subprocess can't remap)
      const { mountRoot, cleanup } = createCanonicalSymlinks(config);
      const sEnv = symlinkEnv(config, mountRoot);

      const [cmd, ...args] = config.command;
      // nosemgrep: javascript.lang.security.detect-child-process — sandbox provider: spawning is its purpose
      const child = spawn(cmd, args, {
        cwd: sEnv.AX_WORKSPACE,
        env: {
          ...process.env,
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
      return true; // Always available — it's just a subprocess
    },
  };
}
