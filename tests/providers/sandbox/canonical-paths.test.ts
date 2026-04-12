import { describe, test, expect } from 'vitest';

import {
  CANONICAL,
  canonicalEnv,
  createCanonicalSymlinks,
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
});

describe('canonicalEnv', () => {
  test('returns canonical paths regardless of host paths', () => {
    const config = mockSandboxConfig();
    const env = canonicalEnv(config);

    expect(env.AX_WORKSPACE).toBe('/workspace');
    expect(env.AX_IPC_SOCKET).toBe(config.ipcSocket);
  });

  test('redirects caches to /tmp', () => {
    const env = canonicalEnv(mockSandboxConfig());
    expect(env.npm_config_cache).toBe('/tmp/.ax-npm-cache');
    expect(env.XDG_CACHE_HOME).toBe('/tmp/.ax-cache');
    expect(env.AX_HOME).toBe('/tmp/.ax-agent');
  });

  test('prepends /workspace/bin to PATH', () => {
    const config = mockSandboxConfig();
    const env = canonicalEnv(config);
    expect(env.PATH).toMatch(/^\/workspace\/bin:/);
  });
});

describe('createCanonicalSymlinks', () => {
  test('returns workspace as mountRoot with no-op cleanup', () => {
    const config = mockSandboxConfig();
    const { mountRoot, cleanup } = createCanonicalSymlinks(config);

    expect(mountRoot).toBe(config.workspace);
    // cleanup is a no-op, should not throw
    cleanup();
  });
});
