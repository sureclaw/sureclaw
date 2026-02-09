import { spawn } from 'node:child_process';
import type { SandboxProvider, SandboxConfig, SandboxProcess, Config } from '../types.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  let warned = false;

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      if (!warned) {
        console.warn('[sandbox-subprocess] WARNING: No isolation — dev-only fallback');
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

      const exitCode = new Promise<number>((resolve, reject) => {
        child.on('exit', (code) => resolve(code ?? 1));
        child.on('error', reject);
      });

      // Enforce timeout
      if (config.timeoutSec) {
        setTimeout(() => {
          if (!child.killed) {
            child.kill('SIGKILL');
          }
        }, config.timeoutSec * 1000);
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
      return true; // Always available — it's just a subprocess
    },
  };
}
