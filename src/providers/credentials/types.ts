// src/providers/credentials/types.ts — Credential provider types

export interface CredentialProvider {
  get(service: string, scope?: string): Promise<string | null>;
  set(service: string, value: string, scope?: string): Promise<void>;
  delete(service: string, scope?: string): Promise<void>;
  list(scope?: string): Promise<string[]>;
  /**
   * Return all {scope, envName} rows whose `scope` starts with `prefix`.
   * Used to enumerate credentials across a family of scopes
   * (e.g., all `user:<agentName>:*` rows) without knowing every concrete scope.
   */
  listScopePrefix(prefix: string): Promise<Array<{ scope: string; envName: string }>>;
}
