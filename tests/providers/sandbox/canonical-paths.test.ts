import { describe, test, expect, afterEach } from 'vitest';
import { existsSync, lstatSync, readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** Check if a symlink exists (without following it to the target). */
function symlinkExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}
import {
  CANONICAL,
  canonicalEnv,
  createCanonicalSymlinks,
  symlinkEnv,
} from '../../../src/providers/sandbox/canonical-paths.js';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

function mockSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    workspace: '/home/alice/.ax/data/workspaces/main/cli/default',
    ipcSocket: '/tmp/ax-ipc-abc123/agent.sock',
    command: ['node', 'runner.js'],
    ...overrides,
  };
}

describe('CANONICAL constants', () => {
  test('root is /workspace (mount root / CWD)', () => {
    expect(CANONICAL.root).toBe('/workspace');
  });

  test('scratch is /workspace/scratch (session workspace)', () => {
    expect(CANONICAL.scratch).toBe('/workspace/scratch');
  });

  test('agent is /workspace/agent (agent workspace)', () => {
    expect(CANONICAL.agent).toBe('/workspace/agent');
  });

  test('user is /workspace/user (per-user persistent storage)', () => {
    expect(CANONICAL.user).toBe('/workspace/user');
  });
});

describe('canonicalEnv', () => {
  test('returns canonical paths regardless of host paths', () => {
    const config = mockSandboxConfig();
    const env = canonicalEnv(config);

    expect(env.AX_WORKSPACE).toBe('/workspace');
    expect(env.AX_IPC_SOCKET).toBe(config.ipcSocket);
  });

  test('includes enterprise fields only when present', () => {
    const config = mockSandboxConfig();
    const envBasic = canonicalEnv(config);

    expect(envBasic.AX_AGENT_WORKSPACE).toBeUndefined();
    expect(envBasic.AX_USER_WORKSPACE).toBeUndefined();

    const envFull = canonicalEnv(mockSandboxConfig({
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
    }));

    expect(envFull.AX_AGENT_WORKSPACE).toBe('/workspace/agent');
    expect(envFull.AX_USER_WORKSPACE).toBe('/workspace/user');
  });

  test('redirects caches to /tmp', () => {
    const env = canonicalEnv(mockSandboxConfig());
    expect(env.npm_config_cache).toBe('/tmp/.ax-npm-cache');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/.ax-cache');
    expect(env.AX_HOME).toBe('/tmp/.ax-agent');
  });

  test('prepends user/bin and agent/bin to PATH when workspaces are active', () => {
    const config = mockSandboxConfig({
      agentWorkspace: '/workspace/agent-real',
      userWorkspace: '/workspace/user-real',
    });
    const env = canonicalEnv(config);
    expect(env.PATH).toMatch(/^\/workspace\/user\/bin:\/workspace\/agent\/bin:/);
  });

  test('omits user/bin from PATH when no user workspace', () => {
    const config = mockSandboxConfig({
      agentWorkspace: '/workspace/agent-real',
    });
    const env = canonicalEnv(config);
    expect(env.PATH).toMatch(/^\/workspace\/agent\/bin:/);
    expect(env.PATH).not.toContain('/workspace/user/bin');
  });

  test('omits bin dirs from PATH when no workspaces', () => {
    const config = mockSandboxConfig();
    const env = canonicalEnv(config);
    expect(env.PATH).toBeUndefined();
  });
});

describe('createCanonicalSymlinks', () => {
  let cleanupFn: (() => void) | undefined;

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = undefined;
  });

  test('creates mount root directory and scratch symlink', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(existsSync(mountRoot)).toBe(true);
    expect(mountRoot).toMatch(/^\/tmp\/.ax-mounts-/);

    const scratchLink = join(mountRoot, 'scratch');
    expect(symlinkExists(scratchLink)).toBe(true);
    expect(readlinkSync(scratchLink)).toBe(config.workspace);
  });

  test('creates enterprise tier symlinks when configured', () => {
    const config = mockSandboxConfig({
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
    });
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(readlinkSync(join(mountRoot, 'agent'))).toBe(config.agentWorkspace);
    expect(readlinkSync(join(mountRoot, 'user'))).toBe(config.userWorkspace);
  });

  test('skips enterprise tier symlinks when not configured', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(existsSync(join(mountRoot, 'agent'))).toBe(false);
    expect(existsSync(join(mountRoot, 'user'))).toBe(false);
  });

  test('cleanup removes mount root', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);

    expect(existsSync(mountRoot)).toBe(true);
    cleanup();
    expect(existsSync(mountRoot)).toBe(false);

    // Double cleanup is safe
    cleanup();
  });
});

describe('symlinkEnv', () => {
  let cleanupFn: (() => void) | undefined;

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = undefined;
  });

  test('returns symlink-based paths under mountRoot', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    const env = symlinkEnv(config, mountRoot);

    expect(env.AX_WORKSPACE).toBe(mountRoot);
    expect(env.AX_IPC_SOCKET).toBe(config.ipcSocket);
  });

  test('includes enterprise fields only when present', () => {
    const config = mockSandboxConfig({
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
    });
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    const env = symlinkEnv(config, mountRoot);

    expect(env.AX_AGENT_WORKSPACE).toBe(join(mountRoot, 'agent'));
    expect(env.AX_USER_WORKSPACE).toBe(join(mountRoot, 'user'));
  });

  test('prepends user/bin and agent/bin to PATH when workspaces are active', () => {
    const config = mockSandboxConfig({
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
    });
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    const env = symlinkEnv(config, mountRoot);
    expect(env.PATH).toMatch(new RegExp(`^${mountRoot}/user/bin:${mountRoot}/agent/bin:`));
  });
});
