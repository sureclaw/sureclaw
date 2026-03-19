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

  /** Replace all placeholders in a Buffer. Returns a new Buffer. */
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
}
