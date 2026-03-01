/**
 * Canonical sandbox paths — simple, consistent paths for agent containers.
 *
 * Instead of mounting host directories at their real paths (leaking structure
 * like /home/alice/.ax/data/workspaces/main/cli/default/), sandbox providers
 * remap mounts to these short canonical paths. The LLM sees /workspace instead
 * of a deeply-nested host path, regardless of sandbox type.
 *
 * Providers that support filesystem remapping (Docker, bwrap, nsjail) mount
 * directly to canonical paths. Providers that don't (seatbelt, subprocess)
 * create symlinks under /tmp and set env vars to the symlink paths.
 */

import { mkdirSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SandboxConfig } from './types.js';

/** Canonical paths inside the sandbox — what the LLM sees. */
export const CANONICAL = {
  workspace:      '/workspace',
  skills:         '/skills',
  agentIdentity:  '/agent-identity',
  agentWorkspace: '/agent-workspace',
  userWorkspace:  '/user-workspace',
  scratch:        '/scratch',
} as const;

/**
 * Build the canonical environment variables for sandbox providers.
 * IPC socket stays at its real host path (not agent-visible, needed by both sides).
 */
export function canonicalEnv(config: SandboxConfig): Record<string, string> {
  return {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: CANONICAL.workspace,
    AX_SKILLS: CANONICAL.skills,
    ...(config.agentDir        ? { AX_AGENT_DIR: CANONICAL.agentIdentity } : {}),
    ...(config.agentWorkspace  ? { AX_AGENT_WORKSPACE: CANONICAL.agentWorkspace } : {}),
    ...(config.userWorkspace   ? { AX_USER_WORKSPACE: CANONICAL.userWorkspace } : {}),
    ...(config.scratchDir      ? { AX_SCRATCH: CANONICAL.scratch } : {}),
    // Redirect caches to /tmp so they don't pollute workspace
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
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

  // workspace → real workspace
  symlinkSync(config.workspace, join(mountRoot, 'workspace'));

  // skills → real skills (separate from workspace)
  symlinkSync(config.skills, join(mountRoot, 'skills'));

  // agent-identity → real agentDir
  if (config.agentDir) {
    symlinkSync(config.agentDir, join(mountRoot, 'agent-identity'));
  }

  // Enterprise tiers
  if (config.agentWorkspace) {
    symlinkSync(config.agentWorkspace, join(mountRoot, 'agent-workspace'));
  }

  if (config.userWorkspace) {
    symlinkSync(config.userWorkspace, join(mountRoot, 'user-workspace'));
  }

  if (config.scratchDir) {
    symlinkSync(config.scratchDir, join(mountRoot, 'scratch'));
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
  return {
    AX_IPC_SOCKET: config.ipcSocket,
    AX_WORKSPACE: join(mountRoot, 'workspace'),
    AX_SKILLS: join(mountRoot, 'skills'),
    ...(config.agentDir        ? { AX_AGENT_DIR: join(mountRoot, 'agent-identity') } : {}),
    ...(config.agentWorkspace  ? { AX_AGENT_WORKSPACE: join(mountRoot, 'agent-workspace') } : {}),
    ...(config.userWorkspace   ? { AX_USER_WORKSPACE: join(mountRoot, 'user-workspace') } : {}),
    ...(config.scratchDir      ? { AX_SCRATCH: join(mountRoot, 'scratch') } : {}),
    npm_config_cache: '/tmp/.ax-npm-cache',
    XDG_CACHE_HOME: '/tmp/.ax-cache',
    AX_HOME: '/tmp/.ax-agent',
  };
}
