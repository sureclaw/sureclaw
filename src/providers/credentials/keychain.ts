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
    async get(service: string): Promise<string | null> {
      const value = await keytar!.getPassword(SERVICE_NAME, service);
      if (value !== null) return value;
      // Fall back to process.env so shell-exported vars still work
      return process.env[service] ?? process.env[service.toUpperCase()] ?? null;
    },

    async set(service: string, value: string): Promise<void> {
      await keytar!.setPassword(SERVICE_NAME, service, value);
    },

    async delete(service: string): Promise<void> {
      await keytar!.deletePassword(SERVICE_NAME, service);
    },

    async list(): Promise<string[]> {
      const creds = await keytar!.findCredentials(SERVICE_NAME);
      return creds.map(c => c.account);
    },
  };
}
