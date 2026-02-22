/**
 * Bubblewrap (bwrap) sandbox provider — Linux namespace-based isolation.
 *
 * Uses bwrap with:
 * - --unshare-net: NO network access (security invariant)
 * - --unshare-pid, --unshare-ipc: PID and IPC namespace isolation
 * - --die-with-parent: kill agent if host dies
 * - Bind-mounts: workspace (rw), skills (ro), IPC socket dir (rw)
 * - Timeout enforced via setTimeout + SIGKILL (same as seatbelt)
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import type { SandboxProvider, SandboxConfig, SandboxProcess } from './types.js';
import type { Config } from '../../types.js';
import { exitCodePromise, enforceTimeout, killProcess, checkCommand, sandboxProcess } from './utils.js';

export async function create(_config: Config): Promise<SandboxProvider> {
  // Project directory — needed so tsx, agent runner source, and node_modules are accessible
  const projectDir = resolve('.');

  // Resolve the Node.js install root (handles nvm, fnm, volta, etc.)
  // e.g. ~/.nvm/versions/node/v24.12.0/bin/node → ~/.nvm/versions/node/v24.12.0
  const nodeDir = dirname(dirname(process.execPath));

  // ~/.local contains bin/claude (symlink) and share/claude (install).
  // Mount read-only so the CLI is on PATH and its target resolves.
  const dotLocal = resolve(homedir(), '.local');
  const hasDotLocal = existsSync(dotLocal);

  return {
    async spawn(config: SandboxConfig): Promise<SandboxProcess> {
      const [cmd, ...args] = config.command;
      const ipcSocketDir = dirname(config.ipcSocket);

      const bwrapArgs: string[] = [
        // Namespace isolation
        '--unshare-net',                          // NO network access
        '--unshare-pid',                          // PID namespace
        '--unshare-ipc',                          // IPC namespace
        '--die-with-parent',                      // kill agent if host dies
        '--new-session',                          // detach from terminal

        // Minimal device and proc mounts
        '--dev', '/dev',
        '--proc', '/proc',

        // Workspace (read-write)
        '--bind', config.workspace, config.workspace,

        // Skills (read-only)
        '--ro-bind', config.skills, config.skills,

        // Agent identity directory (read-only) — SOUL.md, BOOTSTRAP.md, etc.
        ...(config.agentDir ? ['--ro-bind', config.agentDir, config.agentDir] : []),

        // Enterprise three-tier mounts
        ...(config.agentWorkspace ? ['--ro-bind', config.agentWorkspace, config.agentWorkspace] : []),
        ...(config.userWorkspace ? ['--bind', config.userWorkspace, config.userWorkspace] : []),
        ...(config.scratchDir ? ['--bind', config.scratchDir, config.scratchDir] : []),

        // IPC socket directory (read-write)
        '--bind', ipcSocketDir, ipcSocketDir,

        // Temp directory (read-write) — Node.js V8 cache, Claude Code temp files
        '--bind', '/tmp', '/tmp',

        // System essentials (read-only)
        '--ro-bind', '/usr', '/usr',
        '--ro-bind', '/lib', '/lib',
        '--ro-bind', '/lib64', '/lib64',
        '--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf',

        // Project directory (read-only) — tsx, agent runner, node_modules
        '--ro-bind', projectDir, projectDir,

        // Node.js runtime (read-only)
        '--ro-bind', nodeDir, nodeDir,

        // ~/.local (read-only) — Claude Code CLI binary + install
        ...(hasDotLocal ? ['--ro-bind', dotLocal, dotLocal] : []),

        // Minimal environment
        '--setenv', 'PATH', process.env.PATH ?? '/usr/bin:/usr/local/bin',
        '--setenv', 'HOME', config.workspace,
        '--setenv', 'AX_IPC_SOCKET', config.ipcSocket,
        '--setenv', 'AX_WORKSPACE', config.workspace,
        '--setenv', 'AX_SKILLS', config.skills,
        ...(config.agentWorkspace ? ['--setenv', 'AX_AGENT_WORKSPACE', config.agentWorkspace] : []),
        ...(config.userWorkspace ? ['--setenv', 'AX_USER_WORKSPACE', config.userWorkspace] : []),
        ...(config.scratchDir ? ['--setenv', 'AX_SCRATCH', config.scratchDir] : []),
        // Redirect caches and data dirs so they don't pollute the workspace
        '--setenv', 'npm_config_cache', '/tmp/.ax-npm-cache',
        '--setenv', 'XDG_CACHE_HOME', '/tmp/.ax-cache',
        '--setenv', 'AX_HOME', '/tmp/.ax-agent',

        // Working directory
        '--chdir', config.workspace,

        // Command to run
        '--', cmd, ...args,
      ];

      const child = spawn('bwrap', bwrapArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const exitCode = exitCodePromise(child);
      enforceTimeout(child, config.timeoutSec);
      return sandboxProcess(child, exitCode);
    },

    kill: killProcess,

    async isAvailable(): Promise<boolean> {
      return checkCommand('which', ['bwrap']);
    },
  };
}
