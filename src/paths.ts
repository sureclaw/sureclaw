/**
 * Centralized path resolution for AX.
 *
 * All config and data files live under ~/.ax/ by default.
 * Override with AX_HOME env var (useful for tests).
 *
 * Layout:
 *   ~/.ax/
 *     ax.yaml     — main config
 *     .env              — API keys
 *     data/
 *       messages.db     — message queue
 *       conversations.db — conversation history
 *       memory.db       — SQLite memory provider
 *       memory/         — file memory provider
 *       audit.db        — SQLite audit provider
 *       audit/          — file audit provider
 *       credentials.enc — encrypted credentials
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

/** Root directory for all AX files. */
export function axHome(): string {
  return process.env.AX_HOME || join(homedir(), '.ax');
}

/** Path to ax.yaml config file. */
export function configPath(): string {
  return join(axHome(), 'ax.yaml');
}

/** Path to .env file. */
export function envPath(): string {
  return join(axHome(), '.env');
}

/** Path to the data subdirectory. */
export function dataDir(): string {
  return join(axHome(), 'data');
}

/** Resolve a file path under the data directory. */
export function dataFile(...segments: string[]): string {
  return join(dataDir(), ...segments);
}
