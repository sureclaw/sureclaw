/**
 * Credential placeholder management for MITM proxy credential injection.
 *
 * Generates opaque placeholder tokens that are injected into sandbox env vars
 * in place of real credentials. The web proxy uses this map to replace
 * placeholders with real values in intercepted HTTPS traffic.
 *
 * Placeholder format: ax-cred:<hex-random>
 * Designed to be unlikely to collide with legitimate content.
 */

import { randomBytes } from 'node:crypto';

export class CredentialPlaceholderMap {
  /** placeholder → real value */
  private readonly placeholderToReal = new Map<string, string>();
  /** env var name → placeholder */
  private readonly nameToPlaceholder = new Map<string, string>();

  /**
   * Register a credential and return its placeholder token.
   * If the same name is registered twice, the previous mapping is replaced.
   */
  register(envName: string, realValue: string): string {
    // Remove old mapping if re-registering
    const oldPh = this.nameToPlaceholder.get(envName);
    if (oldPh) this.placeholderToReal.delete(oldPh);

    const placeholder = `ax-cred:${randomBytes(16).toString('hex')}`;
    this.placeholderToReal.set(placeholder, realValue);
    this.nameToPlaceholder.set(envName, placeholder);
    return placeholder;
  }

  /** Check if a string contains any registered placeholders. */
  hasPlaceholders(input: string): boolean {
    for (const ph of this.placeholderToReal.keys()) {
      if (input.includes(ph)) return true;
    }
    return false;
  }

  /** Replace all placeholders in a string with real values. */
  replaceAll(input: string): string {
    let result = input;
    for (const [ph, real] of this.placeholderToReal) {
      // Use split+join for global replacement (no regex special chars concern)
      result = result.split(ph).join(real);
    }
    return result;
  }

  /** Replace all placeholders in a Buffer. Returns a new Buffer.
   *  Assumes UTF-8 content (HTTP headers, JSON bodies). Binary data
   *  (file uploads, protobuf) passes through unchanged because placeholders
   *  are ASCII strings that won't appear in non-text content. */
  replaceAllBuffer(input: Buffer): Buffer {
    const str = input.toString('utf-8');
    if (!this.hasPlaceholders(str)) return input;
    return Buffer.from(this.replaceAll(str));
  }

  /** Return env var name → placeholder map for sandbox injection. */
  toEnvMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [name, ph] of this.nameToPlaceholder) {
      result[name] = ph;
    }
    return result;
  }

  /** Return the raw placeholder→real map (for SharedCredentialRegistry merging). */
  entries(): ReadonlyMap<string, string> {
    return this.placeholderToReal;
  }
}

/**
 * Aggregates per-session CredentialPlaceholderMaps so a shared proxy
 * (e.g. k8s) can replace placeholders from any active session.
 *
 * Placeholders are globally unique (ax-cred:<random>), so there's no
 * cross-session collision risk.
 */
export class SharedCredentialRegistry {
  private readonly sessions = new Map<string, CredentialPlaceholderMap>();

  /** Register a session's credential map. Called at sandbox launch. */
  register(sessionId: string, map: CredentialPlaceholderMap): void {
    this.sessions.set(sessionId, map);
  }

  /** Deregister a session's credential map. Called at session cleanup. */
  deregister(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Check if any registered session has placeholders in the input. */
  hasPlaceholders(input: string): boolean {
    for (const map of this.sessions.values()) {
      if (map.hasPlaceholders(input)) return true;
    }
    return false;
  }

  /** Replace placeholders from all active sessions. */
  replaceAll(input: string): string {
    let result = input;
    for (const map of this.sessions.values()) {
      result = map.replaceAll(result);
    }
    return result;
  }

  /** Replace placeholders in a Buffer across all active sessions.
   *  Assumes UTF-8 content. See CredentialPlaceholderMap.replaceAllBuffer. */
  replaceAllBuffer(input: Buffer): Buffer {
    const str = input.toString('utf-8');
    if (!this.hasPlaceholders(str)) return input;
    return Buffer.from(this.replaceAll(str));
  }
}
