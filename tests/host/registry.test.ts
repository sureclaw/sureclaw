import { describe, test, expect } from 'vitest';
import { loadProviders } from '../../src/host/registry.js';
import type { Config } from '../../src/types.js';

const config: Config = {
  profile: 'paranoid',
  providers: {
    memory: 'cortex',
    security: 'patterns',
    channels: ['cli'],
    web: { extract: 'none', search: 'none' },
   
    credentials: 'keychain',
    skills: 'database',
    audit: 'database',
    sandbox: 'docker',
    scheduler: 'none',
  },
  sandbox: { timeout_sec: 120, memory_mb: 512 },
  scheduler: {
    active_hours: { start: '07:00', end: '23:00', timezone: 'America/New_York' },
    max_token_budget: 4096,
    heartbeat_interval_min: 30,
  },
};

describe('Provider registry', () => {
  test('rejects unknown provider name via resolveProviderPath', async () => {
    const { resolveProviderPath } = await import('../../src/host/provider-map.js');
    expect(() => resolveProviderPath('llm', 'evil')).toThrow('Unknown llm provider');
  });

  test('rejects unknown provider kind via resolveProviderPath', async () => {
    const { resolveProviderPath } = await import('../../src/host/provider-map.js');
    expect(() => resolveProviderPath('fakekind', 'foo')).toThrow('Unknown provider kind');
  });

  test('loadProviders is a callable function', () => {
    expect(typeof loadProviders).toBe('function');
  });
});
