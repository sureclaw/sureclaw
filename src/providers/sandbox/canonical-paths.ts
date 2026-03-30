/**
 * Canonical sandbox paths — simple, consistent paths for agent containers.
 *
 * Instead of mounting host directories at their real paths (leaking structure
 * like /home/alice/.ax/data/workspaces/main/cli/default/), sandbox providers
 * remap mounts to these short canonical paths. The LLM sees /scratch instead
 * of a deeply-nested host path, regardless of sandbox type.
 *
 * Canonical mount table (all under /workspace, which is the CWD):
 *   /workspace          — CWD/HOME (mount root, read-only)
 *   /workspace/scratch  — Session working files (rw, lost when session ends)
 *   /workspace/agent    — Agent workspace, persistent shared files (rw for admin users only)
 *   /workspace/user     — Per-user persistent storage (rw when workspace provider active)
 *
 * In k8s mode, scratch is backed by GCS via the workspace provider's 'session'
 * scope, so its content survives across pod restarts within the same conversation.
 *
 * Identity files are sent via stdin payload (loaded from DocumentStore).
 * Agent-level skills (from plugins/admin) are in agent/skills/.
 * User-created skills are in user/skills/.
 * Tool stubs are in agent/tools/.
 *
 * Providers that support filesystem remapping (Docker, bwrap, nsjail) mount
 * directly to canonical paths. Providers that don't (seatbelt, subprocess)
 * create symlinks under /tmp and set env vars to the symlink paths.
 */

import { mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxConfig } from './types.js';

/** Canonical paths inside the sandbox — what the LLM sees.
 * /workspace root is read-only in Docker and k8s (readOnlyRootFilesystem).
 * Apple Container root is currently writable (TODO: re-enable --read-only
 * once --publish-socket works with a non-tmpfs bridge socket path). */
export const CANONICAL = {
  root:     '/workspace',
  scratch:  '/workspace/scratch',
  agent:    '/workspace/agent',
  user:     '/workspace/user',
} as const;

/**
 * Build the canonical environment variables for sandbox providers.
 * IPC socket stays at its real host path (not agent-visible, needed by both sides).
 */
export function canonicalEnv(config: SandboxConfig): Record<string, string> {
  // web-proxy.sock is in the same directory as the IPC socket (already mounted).
  // In k8s HTTP mode, ipcSocket is empty — skip the socket (pods use AX_WEB_PROXY_URL instead).
  const ipcDir = config.ipcSocket ? dirname(config.ipcSocket) : '';
  const webProxySocket = ipcDir ? join(ipcDir, 'web-proxy.sock') : '';

  // Prepend user/bin and agent/bin to PATH so installed skill binaries are available
  const binPaths: string[] = [];
  if (config.userWorkspace) binPaths.push(join(CANONICAL.user, 'bin'));
  if (config.agentWorkspace) binPaths.push(join(CANONICAL.agent, 'bin'));
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

  const env: Record<string, string> = {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: CANONICAL.root,
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
  if (binPaths.length > 0) env.PATH = `${binPaths.join(':')}:${basePath}`;
  if (webProxySocket) env.AX_WEB_PROXY_SOCKET = webProxySocket;
  if (config.agentWorkspace) env.AX_AGENT_WORKSPACE = CANONICAL.agent;
  if (config.userWorkspace) env.AX_USER_WORKSPACE = CANONICAL.user;

  return env;
}

/**
 * Create symlinks from canonical names to real host paths under a temp directory.
 *
 * Used by providers that can't remap filesystems (seatbelt, subprocess).
 * Returns the mount root (e.g. /tmp/.ax-mounts-<uuid>) and a cleanup function.
 */
export function createCanonicalSymlinks(config: SandboxConfig): {
  mountRoot: string;
  cleanup: () => void;
} {
  const mountRoot = join('/tmp', `.ax-mounts-${randomUUID().slice(0, 8)}`);
  mkdirSync(mountRoot, { recursive: true });

  // scratch → real workspace (session cwd/HOME)
  symlinkSync(config.workspace, join(mountRoot, 'scratch'));

  // agent → agent workspace (rw for admin users only)
  if (config.agentWorkspace) {
    symlinkSync(config.agentWorkspace, join(mountRoot, 'agent'));
  }

  // user → per-user persistent workspace (rw when workspace provider active)
  if (config.userWorkspace) {
    symlinkSync(config.userWorkspace, join(mountRoot, 'user'));
  }

  return {
    mountRoot,
    cleanup: () => {
      try {
        if (existsSync(mountRoot)) {
          rmSync(mountRoot, { recursive: true, force: true });
        }
      } catch {
        // Best-effort cleanup — /tmp will handle the rest
      }
    },
  };
}

/**
 * Build the symlink-based environment variables for providers that can't remap.
 * Points to symlink paths under mountRoot instead of real host paths.
 */
export function symlinkEnv(config: SandboxConfig, mountRoot: string): Record<string, string> {
  // Prepend user/bin and agent/bin to PATH so installed skill binaries are available
  const binPaths: string[] = [];
  if (config.userWorkspace) binPaths.push(join(mountRoot, 'user', 'bin'));
  if (config.agentWorkspace) binPaths.push(join(mountRoot, 'agent', 'bin'));
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

  const env: Record<string, string> = {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: mountRoot,
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
  if (binPaths.length > 0) env.PATH = `${binPaths.join(':')}:${basePath}`;
  if (config.agentWorkspace) env.AX_AGENT_WORKSPACE = join(mountRoot, 'agent');
  if (config.userWorkspace) env.AX_USER_WORKSPACE = join(mountRoot, 'user');

  return env;
}

