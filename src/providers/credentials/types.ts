// src/providers/credentials/types.ts — Credential provider types

export interface CredentialProvider {
  get(service: string, scope?: string): Promise<string | null>;
  set(service: string, value: string, scope?: string): Promise<void>;
  delete(service: string, scope?: string): Promise<void>;
  list(scope?: string): Promise<string[]>;
}
