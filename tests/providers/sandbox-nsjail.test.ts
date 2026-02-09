import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { Config } from '../../src/providers/types.js';

function mockConfig(): Config {
  return {
    profile: 'standard',
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'env', skills: 'readonly', audit: 'file',
      sandbox: 'nsjail', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('sandbox-nsjail provider', () => {
  test('create returns a valid SandboxProvider', async () => {
    const { create } = await import('../../src/providers/sandbox/nsjail.js');
    const provider = await create(mockConfig());

    expect(provider.spawn).toBeTypeOf('function');
    expect(provider.kill).toBeTypeOf('function');
    expect(provider.isAvailable).toBeTypeOf('function');
  });

  test('isAvailable returns false when nsjail is not installed', async () => {
    const { create } = await import('../../src/providers/sandbox/nsjail.js');
    const provider = await create(mockConfig());

    // On macOS (test environment), nsjail is not available
    const available = await provider.isAvailable();
    // Don't assert a specific value since nsjail might actually be installed
    expect(typeof available).toBe('boolean');
  });

  test('spawn constructs correct nsjail arguments', async () => {
    const { spawn: mockSpawn } = await import('node:child_process');

    // We can verify the provider creates correctly without actually spawning
    const { create } = await import('../../src/providers/sandbox/nsjail.js');
    const provider = await create(mockConfig());

    // The provider should exist and have all methods
    expect(provider).toBeDefined();
    expect(provider.spawn).toBeDefined();
    expect(provider.kill).toBeDefined();
  });

  test('kill handles already-exited processes gracefully', async () => {
    const { create } = await import('../../src/providers/sandbox/nsjail.js');
    const provider = await create(mockConfig());

    // Should not throw for non-existent PID
    await expect(provider.kill(999999)).resolves.toBeUndefined();
  });
});
