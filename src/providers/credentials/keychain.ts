import type { CredentialProvider } from './types.js';
import type { Config } from '../../types.js';
import { withTimeout, TimeoutError } from '../../utils/timeout.js';
import { isKeychainAvailable } from '../../utils/interactive.js';

/**
 * OS keychain credentials provider.
 *
 * Uses native OS credential storage:
 * - macOS: Keychain Access
 * - Linux: libsecret (GNOME Keyring)
 * - Windows: Credential Locker
 *
 * Backed by `keytar` npm package (optional dependency).
 * Falls back to encrypted file provider if keytar is unavailable
 * or if the keychain can't be accessed (non-interactive context,
 * timeout, missing display server).
 *
 * All credentials stored under "ax" service name.
 */

const SERVICE_NAME = 'ax';

/**
 * Timeout for individual keytar operations. keytar calls go through
 * libsecret -> D-Bus -> gnome-keyring-daemon (on Linux). If the
 * keyring is locked and no GUI/TTY is available to prompt for unlock,
 * these calls hang forever. 5 seconds is generous — a working keychain
 * responds in milliseconds.
 */
const KEYTAR_TIMEOUT_MS = 5_000;

/* eslint-disable @typescript-eslint/no-explicit-any */
interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<{ account: string; password: string }[]>;
}

export async function create(config: Config): Promise<CredentialProvider> {
  // Pre-flight: check if the OS keychain is likely to work in this context.
  // On Linux without a display server or TTY, libsecret will try to show
  // an unlock dialog via D-Bus that has nowhere to go — causing a hang.
  // Better to skip straight to the fallback than risk it.
  if (!isKeychainAvailable()) {
    const { getLogger } = await import('../../logger.js');
    getLogger().warn('keychain_non_interactive', {
      message: 'Keychain not available in non-interactive context, falling back to encrypted file provider',
      platform: process.platform,
      hasDisplay: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
      hasTTY: !!process.stdin.isTTY,
    });
    const { create: createEncrypted } = await import('./encrypted.js');
    return createEncrypted(config);
  }

  let keytar: KeytarModule | null = null;

  try {
    keytar = (await import('keytar')) as any as KeytarModule;
    // Verify it actually works by trying a list operation — WITH a timeout.
    // This catches both "keytar not installed" and "keychain locked/hanging".
    await withTimeout(
      keytar.findCredentials(SERVICE_NAME),
      KEYTAR_TIMEOUT_MS,
      'keytar.findCredentials (init)',
    );
  } catch (err) {
    // keytar not available or keychain timed out — fall back to encrypted provider
    const { getLogger } = await import('../../logger.js');
    const isTimeout = err instanceof TimeoutError;
    getLogger().warn('keytar_unavailable', {
      message: isTimeout
        ? 'Keychain operation timed out — the keyring may be locked. Falling back to encrypted file provider.'
        : 'keytar not available, falling back to encrypted file provider',
      reason: isTimeout ? 'timeout' : 'import_failed',
      suggestion: isTimeout
        ? 'Unlock your keyring before starting AX, or use AX_CREDS_PASSPHRASE for non-interactive environments.'
        : 'Install keytar for native keychain support: npm install keytar',
    });
    const { create: createEncrypted } = await import('./encrypted.js');
    return createEncrypted(config);
  }

  return {
    async get(service: string): Promise<string | null> {
      return withTimeout(
        keytar!.getPassword(SERVICE_NAME, service),
        KEYTAR_TIMEOUT_MS,
        'keytar.getPassword',
      );
    },

    async set(service: string, value: string): Promise<void> {
      await withTimeout(
        keytar!.setPassword(SERVICE_NAME, service, value),
        KEYTAR_TIMEOUT_MS,
        'keytar.setPassword',
      );
    },

    async delete(service: string): Promise<void> {
      await withTimeout(
        keytar!.deletePassword(SERVICE_NAME, service),
        KEYTAR_TIMEOUT_MS,
        'keytar.deletePassword',
      );
    },

    async list(): Promise<string[]> {
      const creds = await withTimeout(
        keytar!.findCredentials(SERVICE_NAME),
        KEYTAR_TIMEOUT_MS,
        'keytar.findCredentials',
      );
      return creds.map(c => c.account);
    },
  };
}
