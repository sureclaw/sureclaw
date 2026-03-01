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
  roOverlaps,
} from '../../../src/providers/sandbox/canonical-paths.js';
import type { SandboxConfig } from '../../../src/providers/sandbox/types.js';

function mockSandboxConfig(overrides?: Partial<SandboxConfig>): SandboxConfig {
  return {
    workspace: '/home/alice/.ax/data/workspaces/main/cli/default',
    skills: '/home/alice/.ax/data/workspaces/main/cli/default/skills',
    ipcSocket: '/tmp/ax-ipc-abc123/agent.sock',
    command: ['node', 'runner.js'],
    ...overrides,
  };
}

describe('CANONICAL constants', () => {
  test('workspace is /workspace', () => {
    expect(CANONICAL.workspace).toBe('/workspace');
  });

  test('skills is /skills (separate top-level mount)', () => {
    expect(CANONICAL.skills).toBe('/skills');
  });

  test('agentIdentity is /agent-identity', () => {
    expect(CANONICAL.agentIdentity).toBe('/agent-identity');
  });

  test('agentWorkspace is /agent-workspace', () => {
    expect(CANONICAL.agentWorkspace).toBe('/agent-workspace');
  });

  test('userWorkspace is /user-workspace', () => {
    expect(CANONICAL.userWorkspace).toBe('/user-workspace');
  });

  test('scratch is /scratch', () => {
    expect(CANONICAL.scratch).toBe('/scratch');
  });
});

describe('canonicalEnv', () => {
  test('returns canonical paths regardless of host paths', () => {
    const config = mockSandboxConfig();
    const env = canonicalEnv(config);

    expect(env.AX_WORKSPACE).toBe('/workspace');
    expect(env.AX_SKILLS).toBe('/skills');
    expect(env.AX_IPC_SOCKET).toBe(config.ipcSocket);
  });

  test('includes enterprise fields only when present', () => {
    const config = mockSandboxConfig();
    const envBasic = canonicalEnv(config);

    expect(envBasic.AX_AGENT_DIR).toBeUndefined();
    expect(envBasic.AX_AGENT_WORKSPACE).toBeUndefined();
    expect(envBasic.AX_USER_WORKSPACE).toBeUndefined();
    expect(envBasic.AX_SCRATCH).toBeUndefined();

    const envFull = canonicalEnv(mockSandboxConfig({
      agentDir: '/home/alice/.ax/agents/main/agent',
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
      scratchDir: '/tmp/ax-scratch-xyz',
    }));

    expect(envFull.AX_AGENT_DIR).toBe('/agent-identity');
    expect(envFull.AX_AGENT_WORKSPACE).toBe('/agent-workspace');
    expect(envFull.AX_USER_WORKSPACE).toBe('/user-workspace');
    expect(envFull.AX_SCRATCH).toBe('/scratch');
  });

  test('redirects caches to /tmp', () => {
    const env = canonicalEnv(mockSandboxConfig());
    expect(env.npm_config_cache).toBe('/tmp/.ax-npm-cache');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/.ax-cache');
    expect(env.AX_HOME).toBe('/tmp/.ax-agent');
  });
});

describe('createCanonicalSymlinks', () => {
  let cleanupFn: (() => void) | undefined;

  afterEach(() => {
    cleanupFn?.();
    cleanupFn = undefined;
  });

  test('creates mount root directory and workspace symlink', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(existsSync(mountRoot)).toBe(true);
    expect(mountRoot).toMatch(/^\/tmp\/.ax-mounts-/);

    const wsLink = join(mountRoot, 'workspace');
    expect(symlinkExists(wsLink)).toBe(true);
    expect(readlinkSync(wsLink)).toBe(config.workspace);
  });

  test('creates skills symlink', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    const skillsLink = join(mountRoot, 'skills');
    expect(symlinkExists(skillsLink)).toBe(true);
    expect(readlinkSync(skillsLink)).toBe(config.skills);
  });

  test('creates enterprise tier symlinks when configured', () => {
    const config = mockSandboxConfig({
      agentDir: '/home/alice/.ax/agents/main/agent',
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
      scratchDir: '/tmp/ax-scratch-xyz',
    });
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(readlinkSync(join(mountRoot, 'agent-identity'))).toBe(config.agentDir);
    expect(readlinkSync(join(mountRoot, 'agent-workspace'))).toBe(config.agentWorkspace);
    expect(readlinkSync(join(mountRoot, 'user-workspace'))).toBe(config.userWorkspace);
    expect(readlinkSync(join(mountRoot, 'scratch'))).toBe(config.scratchDir);
  });

  test('skips enterprise tier symlinks when not configured', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    expect(existsSync(join(mountRoot, 'agent-identity'))).toBe(false);
    expect(existsSync(join(mountRoot, 'agent-workspace'))).toBe(false);
    expect(existsSync(join(mountRoot, 'user-workspace'))).toBe(false);
    expect(existsSync(join(mountRoot, 'scratch'))).toBe(false);
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

    expect(env.AX_WORKSPACE).toBe(join(mountRoot, 'workspace'));
    expect(env.AX_SKILLS).toBe(join(mountRoot, 'skills'));
    expect(env.AX_IPC_SOCKET).toBe(config.ipcSocket);
  });

  test('includes enterprise fields only when present', () => {
    const config = mockSandboxConfig({
      agentDir: '/home/alice/.ax/agents/main/agent',
      agentWorkspace: '/home/alice/.ax/agents/main/agent/workspace',
      userWorkspace: '/home/alice/.ax/agents/main/users/alice/workspace',
      scratchDir: '/tmp/ax-scratch-xyz',
    });
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);
    cleanupFn = cleanup;

    const env = symlinkEnv(config, mountRoot);

    expect(env.AX_AGENT_DIR).toBe(join(mountRoot, 'agent-identity'));
    expect(env.AX_AGENT_WORKSPACE).toBe(join(mountRoot, 'agent-workspace'));
    expect(env.AX_USER_WORKSPACE).toBe(join(mountRoot, 'user-workspace'));
    expect(env.AX_SCRATCH).toBe(join(mountRoot, 'scratch'));
  });
});

describe('roOverlaps', () => {
  test('detects skills as subdirectory of workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/.ax/data/workspaces/main/cli/default',
      skills: '/home/alice/.ax/data/workspaces/main/cli/default/skills',
    });
    const overlaps = roOverlaps(config);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({
      hostPath: '/home/alice/.ax/data/workspaces/main/cli/default/skills',
      canonicalPath: '/workspace/skills',
    });
  });

  test('returns empty when skills is outside workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/.ax/data/workspaces/main/cli/default',
      skills: '/home/alice/.ax/data/skills-global',
    });
    const overlaps = roOverlaps(config);
    expect(overlaps).toHaveLength(0);
  });

  test('returns empty when skills is a sibling of workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/projects/myapp',
      skills: '/home/alice/projects/skills',
    });
    const overlaps = roOverlaps(config);
    expect(overlaps).toHaveLength(0);
  });

  test('returns empty when skills equals workspace (same directory)', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/home/alice/work',
    });
    const overlaps = roOverlaps(config);
    expect(overlaps).toHaveLength(0);
  });

  test('detects deeply nested skills under workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/home/alice/work/data/agent/skills',
    });
    const overlaps = roOverlaps(config);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0].canonicalPath).toBe('/workspace/data/agent/skills');
  });

  test('detects agentDir under workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/opt/global-skills',
      agentDir: '/home/alice/work/.agent',
    });
    const overlaps = roOverlaps(config);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({
      hostPath: '/home/alice/work/.agent',
      canonicalPath: '/workspace/.agent',
    });
  });

  test('detects agentWorkspace under workspace', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/opt/global-skills',
      agentWorkspace: '/home/alice/work/shared',
    });
    const overlaps = roOverlaps(config);

    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]).toEqual({
      hostPath: '/home/alice/work/shared',
      canonicalPath: '/workspace/shared',
    });
  });

  test('detects multiple overlapping RO dirs', () => {
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/home/alice/work/skills',
      agentDir: '/home/alice/work/.agent',
      agentWorkspace: '/home/alice/work/shared',
    });
    const overlaps = roOverlaps(config);

    expect(overlaps).toHaveLength(3);
    const paths = overlaps.map(o => o.canonicalPath).sort();
    expect(paths).toEqual(['/workspace/.agent', '/workspace/shared', '/workspace/skills']);
  });

  test('ignores rw directories (userWorkspace, scratchDir)', () => {
    // userWorkspace and scratchDir are mounted rw, so they are not checked
    const config = mockSandboxConfig({
      workspace: '/home/alice/work',
      skills: '/opt/global-skills',
      userWorkspace: '/home/alice/work/user-data',
      scratchDir: '/home/alice/work/scratch',
    });
    const overlaps = roOverlaps(config);
    expect(overlaps).toHaveLength(0);
  });
});
