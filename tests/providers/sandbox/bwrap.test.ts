import { describe, test, expect } from 'vitest';
import type { Config } from '../../../src/types.js';

function mockConfig(): Config {
  return {
    profile: 'balanced',
    providers: {
      llm: 'mock', memory: 'file', scanner: 'basic',
      channels: ['cli'], web: 'none', browser: 'none',
      credentials: 'env', skills: 'readonly', audit: 'file',
      sandbox: 'bwrap', scheduler: 'none',
    },
    sandbox: { timeout_sec: 30, memory_mb: 256 },
    scheduler: {
      active_hours: { start: '08:00', end: '22:00', timezone: 'UTC' },
      max_token_budget: 1000,
      heartbeat_interval_min: 5,
    },
  };
}

describe('sandbox-bwrap provider', () => {
  test('create returns a valid SandboxProvider', async () => {
    const { create } = await import('../../../src/providers/sandbox/bwrap.js');
    const provider = await create(mockConfig());

    expect(provider.spawn).toBeTypeOf('function');
    expect(provider.kill).toBeTypeOf('function');
    expect(provider.isAvailable).toBeTypeOf('function');
  });

  test('isAvailable returns a boolean', async () => {
    const { create } = await import('../../../src/providers/sandbox/bwrap.js');
    const provider = await create(mockConfig());

    const available = await provider.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('provider has all required methods', async () => {
    const { create } = await import('../../../src/providers/sandbox/bwrap.js');
    const provider = await create(mockConfig());

    expect(provider).toBeDefined();
    expect(provider.spawn).toBeDefined();
    expect(provider.kill).toBeDefined();
  });

  test('kill handles already-exited processes gracefully', async () => {
    const { create } = await import('../../../src/providers/sandbox/bwrap.js');
    const provider = await create(mockConfig());

    // Should not throw for non-existent PID
    await expect(provider.kill(999999)).resolves.toBeUndefined();
  });
});
