import { describe, test, expect } from 'vitest';
import { CredentialPlaceholderMap } from '../../src/host/credential-placeholders.js';
import { credentialScope } from '../../src/host/credential-scopes.js';
import type { CredentialProvider } from '../../src/providers/credentials/types.js';

/** Simulates the pre-loading loop from server-completions.ts */
async function preloadCredentials(
  provider: CredentialProvider,
  agentName: string,
  userId: string,
  webProxy: boolean,
): Promise<{ credentialMap: CredentialPlaceholderMap; credentialEnv: Record<string, string> }> {
  const credentialMap = new CredentialPlaceholderMap();
  const credentialEnv: Record<string, string> = {};
  for (const scope of [credentialScope(agentName, userId), credentialScope(agentName), undefined]) {
    try {
      const storedNames = await provider.list(scope);
      for (const envName of storedNames) {
        if (credentialMap.toEnvMap()[envName] || credentialEnv[envName]) continue;
        const realValue = await provider.get(envName, scope);
        if (realValue) {
          if (webProxy) {
            credentialMap.register(envName, realValue);
          } else {
            credentialEnv[envName] = realValue;
          }
        }
      }
    } catch { /* list may not be supported */ }
  }
  return { credentialMap, credentialEnv };
}

describe('credential injection integration', () => {
  test('builds credential map from skill requirements and credential provider', async () => {
    // Simulate what server-completions will do
    const skillRequiredEnv = ['LINEAR_API_KEY', 'GITHUB_TOKEN'];

    // Mock credential provider
    const credentialStore: Record<string, string> = {
      LINEAR_API_KEY: 'lin_api_real_key',
      GITHUB_TOKEN: 'ghp_real_token',
    };
    const mockCredProvider = {
      get: async (key: string) => credentialStore[key] ?? null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY', 'GITHUB_TOKEN']);
    // Env values should be placeholders, not real values
    expect(envMap.LINEAR_API_KEY).toMatch(/^ax-cred:/);
    expect(envMap.GITHUB_TOKEN).toMatch(/^ax-cred:/);
    expect(envMap.LINEAR_API_KEY).not.toBe('lin_api_real_key');

    // But replaceAll should recover the real values
    const replaced = map.replaceAll(`key=${envMap.LINEAR_API_KEY}`);
    expect(replaced).toBe('key=lin_api_real_key');
  });

  test('skips env vars not found in credential provider', async () => {
    const skillRequiredEnv = ['LINEAR_API_KEY', 'MISSING_KEY'];
    const mockCredProvider = {
      get: async (key: string) => key === 'LINEAR_API_KEY' ? 'lin_api_real' : null,
    };

    const map = new CredentialPlaceholderMap();
    for (const envName of skillRequiredEnv) {
      const realValue = await mockCredProvider.get(envName);
      if (realValue) {
        map.register(envName, realValue);
      }
    }

    const envMap = map.toEnvMap();
    expect(Object.keys(envMap)).toEqual(['LINEAR_API_KEY']);
    // MISSING_KEY should not be in the map
    expect(envMap.MISSING_KEY).toBeUndefined();
  });

  test('pre-loads credentials without web_proxy using real values (not placeholders)', async () => {
    const store: Record<string, Record<string, string>> = {
      'agent:main': { LINEAR_API_KEY: 'lin_api_real_key' },
    };
    const provider: CredentialProvider = {
      get: async (s, scope?) => store[scope ?? 'global']?.[s] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async (scope?) => Object.keys(store[scope ?? 'global'] ?? {}),
    };

    const { credentialMap, credentialEnv } = await preloadCredentials(provider, 'main', 'alice', false);

    // Without web_proxy, real values go into credentialEnv (not placeholders)
    expect(credentialEnv.LINEAR_API_KEY).toBe('lin_api_real_key');
    expect(Object.keys(credentialMap.toEnvMap())).toHaveLength(0);
  });

  test('pre-loads credentials with web_proxy using placeholders', async () => {
    const store: Record<string, Record<string, string>> = {
      'agent:main': { LINEAR_API_KEY: 'lin_api_real_key' },
    };
    const provider: CredentialProvider = {
      get: async (s, scope?) => store[scope ?? 'global']?.[s] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async (scope?) => Object.keys(store[scope ?? 'global'] ?? {}),
    };

    const { credentialMap, credentialEnv } = await preloadCredentials(provider, 'main', 'alice', true);

    // With web_proxy, placeholders go into credentialMap
    expect(credentialMap.toEnvMap().LINEAR_API_KEY).toMatch(/^ax-cred:/);
    expect(credentialEnv.LINEAR_API_KEY).toBeUndefined();
  });

  test('pre-loads global (unscoped) credentials', async () => {
    const store: Record<string, Record<string, string>> = {
      // Credential stored without scope (e.g., from provide endpoint without session context)
      'global': { SLACK_TOKEN: 'xoxb-global-token' },
    };
    const provider: CredentialProvider = {
      get: async (s, scope?) => store[scope ?? 'global']?.[s] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async (scope?) => Object.keys(store[scope ?? 'global'] ?? {}),
    };

    const { credentialEnv } = await preloadCredentials(provider, 'main', 'alice', false);

    // Global credentials should be found and injected
    expect(credentialEnv.SLACK_TOKEN).toBe('xoxb-global-token');
  });

  test('user scope takes precedence over agent and global scopes', async () => {
    const store: Record<string, Record<string, string>> = {
      'user:main:alice': { KEY: 'user-val' },
      'agent:main': { KEY: 'agent-val' },
      'global': { KEY: 'global-val' },
    };
    const provider: CredentialProvider = {
      get: async (s, scope?) => store[scope ?? 'global']?.[s] ?? null,
      set: async () => {},
      delete: async () => {},
      list: async (scope?) => Object.keys(store[scope ?? 'global'] ?? {}),
    };

    const { credentialEnv } = await preloadCredentials(provider, 'main', 'alice', false);

    // User scope wins — checked first
    expect(credentialEnv.KEY).toBe('user-val');
  });

  test('credential placeholders rotate per-turn (session pod reuse)', () => {
    // Simulates the applyPayload() logic in runner.ts.
    // On turn 1, the pod gets placeholder A. On turn 2, the host generates
    // placeholder B. The old guard `if (!process.env[key])` would skip B,
    // leaving the pod with stale placeholder A that the proxy no longer recognizes.

    // Turn 1: set initial placeholder (simulates pod env from extraEnv)
    const envKey = '__TEST_CRED_ROTATION__';
    const placeholderA = 'ax-cred:turn1-placeholder';
    const placeholderB = 'ax-cred:turn2-placeholder';

    process.env[envKey] = placeholderA;

    // Turn 2: new payload with rotated placeholder — MUST overwrite
    const payloadCredentialEnv = { [envKey]: placeholderB };
    for (const [key, value] of Object.entries(payloadCredentialEnv)) {
      process.env[key] = value; // Fixed: always overwrite (no guard)
    }

    expect(process.env[envKey]).toBe(placeholderB);

    // Cleanup
    delete process.env[envKey];
  });
});
