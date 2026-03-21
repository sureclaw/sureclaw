import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { credentialsPath } from '../../paths.js';
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';

/**
 * Build a namespaced store key.  When scope is provided the key becomes
 * `scope::service` so that identical service names can coexist across
 * different isolation boundaries (e.g. per-agent, per-user).
 */
function scopedKey(service: string, scope?: string): string {
  if (!scope) return service;
  return `${scope}::${service}`;
}

/**
 * Plaintext YAML credential provider.
 *
 * Reads/writes credentials as key-value pairs in ~/.ax/credentials.yaml.
 * Falls back to process.env for individual get() lookups so shell-exported
 * vars (e.g. OPENROUTER_API_KEY) still work.
 *
 * This replaces the old read-only `env` provider with a provider that can
 * actually persist credentials through the onboarding wizard and OAuth refresh.
 */
export async function create(_config: Config): Promise<CredentialProvider> {
  const filePath = process.env.AX_CREDS_YAML_PATH || credentialsPath();

  function loadStore(): Record<string, string> {
    if (!existsSync(filePath)) return {};
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      return {};
    } catch {
      return {};
    }
  }

  function saveStore(store: Record<string, string>): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const content = yamlStringify(store, { indent: 2, lineWidth: 120 });
    writeFileSync(filePath, content, 'utf-8');
  }

  return {
    async get(service: string, scope?: string): Promise<string | null> {
      const store = loadStore();
      const key = scopedKey(service, scope);
      if (store[key] !== undefined) return store[key];
      // Only fall back to process.env for default (unscoped) calls
      if (!scope) {
        return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
      }
      return null;
    },

    async set(service: string, value: string, scope?: string): Promise<void> {
      const store = loadStore();
      const key = scopedKey(service, scope);
      store[key] = value;
      saveStore(store);
      if (!scope) {
        process.env[service] = value;
      }
    },

    async delete(service: string, scope?: string): Promise<void> {
      const store = loadStore();
      const key = scopedKey(service, scope);
      delete store[key];
      saveStore(store);
      if (!scope) {
        delete process.env[service];
      }
    },

    async list(scope?: string): Promise<string[]> {
      const store = loadStore();
      if (!scope) {
        // Return only non-scoped keys (backward compat)
        return Object.keys(store).filter(k => !k.includes('::'));
      }
      const prefix = `${scope}::`;
      return Object.keys(store)
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length));
    },
  };
}
