import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { credentialsPath } from '../../paths.js';
import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';

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
    async get(service: string): Promise<string | null> {
      const store = loadStore();
      if (store[service] !== undefined) return store[service];
      // Fall back to process.env (case-insensitive: try exact, then UPPER)
      return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
    },

    async set(service: string, value: string): Promise<void> {
      const store = loadStore();
      store[service] = value;
      saveStore(store);
      // Also update process.env so the value is immediately available
      process.env[service] = value;
    },

    async delete(service: string): Promise<void> {
      const store = loadStore();
      delete store[service];
      saveStore(store);
      delete process.env[service];
    },

    async list(): Promise<string[]> {
      const store = loadStore();
      return Object.keys(store);
    },
  };
}
