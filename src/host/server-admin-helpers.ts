// src/host/server-admin-helpers.ts — Pure admin helper functions extracted from server.ts.
//
// These are imported by server.ts, server-completions.ts, and IPC handlers.

import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { agentIdentityDir, agentIdentityFilesDir } from '../paths.js';

/** Returns true when the agent is still in bootstrap mode (missing SOUL.md or IDENTITY.md while BOOTSTRAP.md present). */
export function isAgentBootstrapMode(agentName: string): boolean {
  const configDir = agentIdentityDir(agentName);
  const idFilesDir = agentIdentityFilesDir(agentName);
  if (!existsSync(join(configDir, 'BOOTSTRAP.md'))) return false;
  return !existsSync(join(idFilesDir, 'SOUL.md')) || !existsSync(join(idFilesDir, 'IDENTITY.md'));
}

/** Returns true when the given userId appears in the agent's admins file. */
export function isAdmin(agentDirPath: string, userId: string): boolean {
  const adminsPath = join(agentDirPath, 'admins');
  if (!existsSync(adminsPath)) return false;
  const lines = readFileSync(adminsPath, 'utf-8').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.includes(userId);
}

/** Appends a userId to the agent's admins file. */
export function addAdmin(agentDirPath: string, userId: string): void {
  const adminsPath = join(agentDirPath, 'admins');
  appendFileSync(adminsPath, `${userId}\n`, 'utf-8');
}

/**
 * Atomically claims the bootstrap admin slot for the given userId.
 * Returns true if this user is the first to claim (and is added to admins).
 * Returns false if someone already claimed it.
 * The 'wx' flag (O_EXCL) ensures only one caller wins the race.
 */
export function claimBootstrapAdmin(agentDirPath: string, userId: string): boolean {
  const claimPath = join(agentDirPath, '.bootstrap-admin-claimed');

  // If the claim file exists but the claimed user is no longer in admins
  // (e.g. admins was reset to re-bootstrap), remove the stale claim.
  if (existsSync(claimPath)) {
    const claimedUser = readFileSync(claimPath, 'utf-8').trim();
    if (!isAdmin(agentDirPath, claimedUser)) {
      unlinkSync(claimPath);
    }
  }

  try {
    writeFileSync(claimPath, userId, { flag: 'wx' });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  addAdmin(agentDirPath, userId);
  return true;
}
