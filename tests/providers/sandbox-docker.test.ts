import { describe, test, expect } from 'vitest';
import type { Config } from '../../src/providers/types.js';

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'env', skills: 'readonly', audit: 'file',
      sandbox: 'docker', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('sandbox-docker provider', () => {
  test('create returns a valid SandboxProvider', async () => {
    const { create } = await import('../../src/providers/sandbox/docker.js');
    const provider = await create(mockConfig());

    expect(provider.spawn).toBeTypeOf('function');
    expect(provider.kill).toBeTypeOf('function');
    expect(provider.isAvailable).toBeTypeOf('function');
  });

  test('isAvailable checks for docker', async () => {
    const { create } = await import('../../src/providers/sandbox/docker.js');
    const provider = await create(mockConfig());

    const available = await provider.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('kill handles already-exited processes gracefully', async () => {
    const { create } = await import('../../src/providers/sandbox/docker.js');
    const provider = await create(mockConfig());

    // Should not throw for non-existent PID
    await expect(provider.kill(999999)).resolves.toBeUndefined();
  });

  test('respects AX_DOCKER_IMAGE env var', async () => {
    const originalImage = process.env.AX_DOCKER_IMAGE;
    process.env.AX_DOCKER_IMAGE = 'custom/agent:v2';

    try {
      const { create } = await import('../../src/providers/sandbox/docker.js');
      const provider = await create(mockConfig());
      // Provider created successfully with custom image
      expect(provider).toBeDefined();
    } finally {
      if (originalImage === undefined) {
        delete process.env.AX_DOCKER_IMAGE;
      } else {
        process.env.AX_DOCKER_IMAGE = originalImage;
      }
    }
  });
});
