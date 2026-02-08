import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { SandboxProvider, SandboxConfig, SandboxProcess, Config } from './types.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  const policyPath = resolve('policies/agent.sb');

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;

      // sandbox-exec wraps the command with the seatbelt profile
      const child = spawn('sandbox-exec', ['-f', policyPath, cmd, ...args], {
        cwd: config.workspace,
        env: {
          // Minimal env — no credentials leak into the sandbox
          PATH: process.env.PATH ?? '/usr/bin:/usr/local/bin',
          HOME: config.workspace,
          SURECLAW_IPC_SOCKET: config.ipcSocket,
          SURECLAW_WORKSPACE: config.workspace,
          SURECLAW_SKILLS: config.skills,
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
      try {
        execFileSync('which', ['sandbox-exec'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
