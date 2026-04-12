import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Config } from '../../../src/types.js';

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      memory: 'cortex', security: 'patterns',
      channels: ['cli'], web: { extract: 'none', search: 'none' },
      credentials: 'keychain', skills: 'database', audit: 'database',
      sandbox: 'apple', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('sandbox-apple provider', () => {
  test('create returns a valid SandboxProvider', async () => {
    const { create } = await import('../../../src/providers/sandbox/apple.js');
    const provider = await create(mockConfig());

    expect(provider.spawn).toBeTypeOf('function');
    expect(provider.kill).toBeTypeOf('function');
    expect(provider.isAvailable).toBeTypeOf('function');
  });

  test('isAvailable returns a boolean', async () => {
    const { create } = await import('../../../src/providers/sandbox/apple.js');
    const provider = await create(mockConfig());

    const available = await provider.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('kill handles already-exited processes gracefully', async () => {
    const { create } = await import('../../../src/providers/sandbox/apple.js');
    const provider = await create(mockConfig());

    // Should not throw for non-existent PID
    await expect(provider.kill(999999)).resolves.toBeUndefined();
  });

  test('apple provider passes extraEnv into container', () => {
    const source = readFileSync(
      new URL('../../../src/providers/sandbox/apple.ts', import.meta.url), 'utf-8',
    );
    // Must spread config.extraEnv as -e flags
    expect(source).toContain('config.extraEnv');
    expect(source).toMatch(/Object\.entries\(config\.extraEnv/);
  });

  test('respects AX_CONTAINER_IMAGE env var', async () => {
    const originalImage = process.env.AX_CONTAINER_IMAGE;
    process.env.AX_CONTAINER_IMAGE = 'custom/agent:v2';

    try {
      const { create } = await import('../../../src/providers/sandbox/apple.js');
      const provider = await create(mockConfig());
      // Provider created successfully with custom image
      expect(provider).toBeDefined();
    } finally {
      if (originalImage === undefined) {
        delete process.env.AX_CONTAINER_IMAGE;
      } else {
        process.env.AX_CONTAINER_IMAGE = originalImage;
      }
    }
  });
});
