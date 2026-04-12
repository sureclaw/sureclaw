/**
 * Canonical sandbox paths — simple, consistent paths for agent containers.
 *
 * Every agent gets a single /workspace directory as its CWD and HOME.
 * In Docker and Apple Container mode, /workspace is bind-mounted from the host.
 * In k8s mode, /workspace is an emptyDir volume synced to a git repo by the git sidecar.
 *
 * /workspace/bin is prepended to PATH so agents can install CLI tools.
 *
 * Identity files are sent via stdin payload (loaded from DocumentStore).
 */

import { dirname, join } from 'node:path';
import type { SandboxConfig } from './types.js';

/** Canonical paths inside the sandbox — what the LLM sees. */
export const CANONICAL = {
  root: '/workspace',
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

  // Prepend /workspace/bin to PATH so installed tools are available
  const basePath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';

  const env: Record<string, string> = {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: CANONICAL.root,
    PATH: `${CANONICAL.root}/bin:${basePath}`,
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
  if (webProxySocket) env.AX_WEB_PROXY_SOCKET = webProxySocket;

  return env;
}

/**
 * Create canonical workspace mount info for the sandbox.
 *
 * Returns the workspace path and a no-op cleanup function.
 * Previously created symlinks for providers that couldn't remap filesystems
 * (seatbelt), but that provider has been removed.
 */
export function createCanonicalSymlinks(config: SandboxConfig): {
  mountRoot: string;
  cleanup: () => void;
} {
  return {
    mountRoot: config.workspace,
    cleanup: () => {},
  };
}
