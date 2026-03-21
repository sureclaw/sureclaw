import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';

/**
 * OS keychain credentials provider.
 *
 * Uses native OS credential storage:
 * - macOS: Keychain Access
 * - Linux: libsecret (GNOME Keyring)
 * - Windows: Credential Locker
 *
 * Backed by `keytar` npm package (optional dependency).
 * Falls back to plaintext YAML provider if keytar is unavailable.
 *
 * All credentials stored under "ax" service name.
 */

const SERVICE_NAME = 'ax';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}

function scopedAccount(service: string, scope?: string): string {
  if (!scope) return service;
  return `${scope}::${service}`;
}

export async function create(config: Config): Promise<CredentialProvider> {
  let keytar: KeytarModule | null = null;

  try {
    keytar = (await import('keytar')) as any as KeytarModule;
    // Verify it actually works by trying a list operation
    await keytar.findCredentials(SERVICE_NAME);
  } catch {
    // keytar not available — fall back to plaintext YAML provider
    const { getLogger } = await import('../../logger.js');
    getLogger().warn('keytar_unavailable', {
      message: 'keytar not available, falling back to plaintext credential store (~/.ax/credentials.yaml)',
      suggestion: 'Install keytar for native keychain support: npm install keytar',
    });
    const { create: createPlaintext } = await import('./plaintext.js');
    return createPlaintext(config);
  }

  return {
    async get(service: string, scope?: string): Promise<string | null> {
      const account = scopedAccount(service, scope);
      const value = await keytar!.getPassword(SERVICE_NAME, account);
      if (value !== null) return value;
      if (!scope) {
        // Fall back to process.env so shell-exported vars still work
        return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
      }
      return null;
    },

    async set(service: string, value: string, scope?: string): Promise<void> {
      const account = scopedAccount(service, scope);
      await keytar!.setPassword(SERVICE_NAME, account, value);
    },

    async delete(service: string, scope?: string): Promise<void> {
      const account = scopedAccount(service, scope);
      await keytar!.deletePassword(SERVICE_NAME, account);
    },

    async list(scope?: string): Promise<string[]> {
      const creds = await keytar!.findCredentials(SERVICE_NAME);
      if (!scope) {
        return creds.filter(c => !c.account.includes('::')).map(c => c.account);
      }
      const prefix = `${scope}::`;
      return creds
        .filter(c => c.account.startsWith(prefix))
        .map(c => c.account.slice(prefix.length));
    },
  };
}
