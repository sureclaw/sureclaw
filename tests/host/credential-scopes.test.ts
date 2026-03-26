// tests/host/credential-scopes.test.ts
import { describe, test, expect } from 'vitest';
import { resolveCredential, credentialScope } from '../../src/host/credential-scopes.js';
import type { CredentialProvider } from '../../src/providers/credentials/types.js';

function mockProvider(store: Record<string, Record<string, string>>): CredentialProvider {
  return {
    get: async (service: string, scope?: string) => store[scope ?? 'global']?.[service] ?? null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
}

describe('credentialScope', () => {
  test('returns user scope when both agentName and userId provided', () => {
    expect(credentialScope('main', 'alice')).toBe('user:main:alice');
  });

  test('returns agent scope when only agentName provided', () => {
    expect(credentialScope('main')).toBe('agent:main');
  });
});

describe('resolveCredential', () => {
  test('user scope overrides agent scope when both exist', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
      'user:main:alice': { KEY: 'user-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('user-val');
  });

  test('user scope overrides agent scope for sandbox env injection', async () => {
    const provider = mockProvider({
      'agent:main': { LINEAR_API_KEY: 'shared-org-key' },
      'user:main:alice': { LINEAR_API_KEY: 'alice-personal-key' },
      'user:main:bob': { LINEAR_API_KEY: 'bob-personal-key' },
    });

    const aliceVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main', 'alice');
    const bobVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main', 'bob');
    const noUserVal = await resolveCredential(provider, 'LINEAR_API_KEY', 'main');

    expect(aliceVal).toBe('alice-personal-key');
    expect(bobVal).toBe('bob-personal-key');
    expect(noUserVal).toBe('shared-org-key');
  });

  test('falls back to agent scope when user scope is missing', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('agent-val');
  });

  test('returns null when neither scope has the credential', async () => {
    const provider = mockProvider({});
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBeNull();
  });

  test('tries agent scope only when no userId', async () => {
    const provider = mockProvider({
      'agent:main': { KEY: 'agent-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main');
    expect(val).toBe('agent-val');
  });

  test('falls back to global scope when scoped credentials are missing', async () => {
    const provider = mockProvider({
      'global': { KEY: 'global-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('global-val');
  });

  test('scoped credential takes precedence over global', async () => {
    const provider = mockProvider({
      'global': { KEY: 'global-val' },
      'agent:main': { KEY: 'agent-val' },
    });
    const val = await resolveCredential(provider, 'KEY', 'main', 'alice');
    expect(val).toBe('agent-val');
  });
});
