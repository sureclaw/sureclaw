/**
 * Minimal .env loader for AX.
 *
 * Reads key=value pairs from ~/.ax/.env into process.env.
 * Safe to call multiple times — skips keys already set in the environment.
 */

import { existsSync, readFileSync } from 'node:fs';
import { envPath } from './paths.js';

export function loadDotEnv(): void {
  const envPathResolved = envPath();
  if (!existsSync(envPathResolved)) return;
  const lines = readFileSync(envPathResolved, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    // Don't override existing env vars
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}
