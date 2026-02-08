import type { CredentialProvider, Config } from './types.js';

export async function create(_config: Config): Promise<CredentialProvider> {
  return {
    async get(service: string): Promise<string | null> {
      return process.env[service.toUpperCase()] ?? null;
    },

    async set(_service: string, _value: string): Promise<void> {
      throw new Error('creds-env is read-only. Use encrypted or keychain provider for writes.');
    },

    async delete(_service: string): Promise<void> {
      throw new Error('creds-env is read-only. Use encrypted or keychain provider for deletes.');
    },

    async list(): Promise<string[]> {
      return Object.keys(process.env).filter(k => !k.startsWith('_'));
    },
  };
}
