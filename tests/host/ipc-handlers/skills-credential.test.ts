import { describe, test, expect } from 'vitest';
import { createSkillsHandlers } from '../../../src/host/ipc-handlers/skills.js';
import type { ProviderRegistry } from '../../../src/types.js';

function mockProviders(credentialStore: Record<string, Record<string, string>> = {}): ProviderRegistry {
  return {
    audit: { log: async () => {}, query: async () => [] },
    credentials: {
      get: async (service: string, scope?: string) => credentialStore[scope ?? 'global']?.[service] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    },
  } as unknown as ProviderRegistry;
}

const ctx = { sessionId: 'test-session', userId: 'test-user', agentId: 'main' } as any;

describe('credential_request handler', () => {
  test('returns available: false when credential is missing', async () => {
    const handlers = createSkillsHandlers(mockProviders());
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(false);
  });

  test('returns available: true when credential exists at agent scope', async () => {
    const handlers = createSkillsHandlers(mockProviders({
      'agent:main': { LINEAR_API_KEY: 'sk-123' },
    }));
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
  });

  test('returns available: true when credential exists at user scope', async () => {
    const handlers = createSkillsHandlers(mockProviders({
      'user:main:test-user': { LINEAR_API_KEY: 'sk-456' },
    }));
    const result = await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.available).toBe(true);
  });

  test('records requested credential in the map', async () => {
    const requested = new Map<string, Set<string>>();
    const handlers = createSkillsHandlers(mockProviders(), { requestedCredentials: requested });
    await handlers.credential_request({ envName: 'LINEAR_API_KEY' }, ctx);
    expect(requested.get('test-session')?.has('LINEAR_API_KEY')).toBe(true);
  });
});
