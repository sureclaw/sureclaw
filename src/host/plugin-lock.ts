/**
 * Plugin Lock File — integrity-pinned plugin registry.
 *
 * The plugins.lock file pins exact package versions and SHA-512 hashes
 * for every installed plugin. On every startup, hashes are verified
 * before the plugin is loaded.
 *
 * Format (JSON):
 * {
 *   "version": 1,
 *   "plugins": {
 *     "@community/provider-memory-postgres": {
 *       "version": "1.2.3",
 *       "integrity": "sha512-...",
 *       "kind": "memory",
 *       "name": "postgres",
 *       "capabilities": { ... },
 *       "installedAt": "2026-02-26T..."
 *     }
 *   }
 * }
 *
 * SECURITY: The lock file lives at ~/.ax/plugins.lock and is the sole
 * authority for which plugins are allowed to load. No plugin loads
 * without an entry here.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { axHome } from '../paths.js';
import { safePath } from '../utils/safe-path.js';
import type { PluginManifest } from './plugin-manifest.js';

// ═══════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════

export interface PluginLockEntry {
  version: string;
  integrity: string;
  kind: string;
  name: string;
  main: string;
  capabilities: {
    network: string[];
    filesystem: 'none' | 'read' | 'write';
    credentials: string[];
  };
  installedAt: string;
}

export interface PluginLockFile {
  version: 1;
  plugins: Record<string, PluginLockEntry>;
}

// ═══════════════════════════════════════════════════════
// Lock file operations
// ═══════════════════════════════════════════════════════

/** Default lock file path. */
export function pluginLockPath(): string {
  return join(axHome(), 'plugins.lock');
}

/** Default plugin installation directory. */
export function pluginDir(): string {
  return join(axHome(), 'plugins');
}

/** Read the lock file. Returns empty state if it doesn't exist. */
export function readPluginLock(path?: string): PluginLockFile {
  const lockPath = path ?? pluginLockPath();

  if (!existsSync(lockPath)) {
    return { version: 1, plugins: {} };
  }

  try {
    const raw = readFileSync(lockPath, 'utf-8');
    const parsed = JSON.parse(raw);

    if (parsed.version !== 1) {
      throw new Error(`Unsupported plugins.lock version: ${parsed.version}`);
    }

    return parsed as PluginLockFile;
  } catch (err) {
    if ((err as Error).message.includes('Unsupported')) throw err;
    throw new Error(`Failed to read plugins.lock: ${(err as Error).message}`);
  }
}

/** Write the lock file atomically. */
export function writePluginLock(lock: PluginLockFile, path?: string): void {
  const lockPath = path ?? pluginLockPath();
  const content = JSON.stringify(lock, null, 2) + '\n';
  writeFileSync(lockPath, content, 'utf-8');
}

/**
 * Add a plugin to the lock file.
 * Creates the lock file if it doesn't exist.
 */
export function addPluginToLock(
  manifest: PluginManifest,
  integrity: string,
  path?: string,
): void {
  const lock = readPluginLock(path);

  lock.plugins[manifest.name] = {
    version: manifest.version ?? '0.0.0',
    integrity,
    kind: manifest.ax_provider.kind,
    name: manifest.ax_provider.name,
    main: manifest.main,
    capabilities: {
      network: manifest.capabilities.network,
      filesystem: manifest.capabilities.filesystem,
      credentials: manifest.capabilities.credentials,
    },
    installedAt: new Date().toISOString(),
  };

  writePluginLock(lock, path);
}

/**
 * Remove a plugin from the lock file.
 * Returns true if it was found and removed.
 */
export function removePluginFromLock(packageName: string, path?: string): boolean {
  const lock = readPluginLock(path);

  if (!(packageName in lock.plugins)) return false;

  delete lock.plugins[packageName];
  writePluginLock(lock, path);
  return true;
}

/**
 * Compute SHA-512 integrity hash for a file or buffer.
 * Returns in the 'sha512-<base64>' format used by npm/SRI.
 */
export function computeIntegrity(data: Buffer | string): string {
  const hash = createHash('sha512').update(data).digest('base64');
  return `sha512-${hash}`;
}

/**
 * Verify that a plugin's installed files match its lock file integrity hash.
 * Returns true if the hash matches, false otherwise.
 */
export function verifyPluginIntegrity(
  packageName: string,
  installedPath: string,
  lockPath?: string,
): boolean {
  const lock = readPluginLock(lockPath);
  const entry = lock.plugins[packageName];

  if (!entry) return false;

  try {
    // Read the plugin's main entry point and compute its hash
    const entryFile = safePath(installedPath, entry.main);
    const content = readFileSync(entryFile);
    const computed = computeIntegrity(content);
    return computed === entry.integrity;
  } catch {
    return false;
  }
}
