import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityFiles } from './prompt/types.js';

function readFile(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf-8');
  } catch {
    return '';
  }
}

export interface IdentityLoadOptions {
  /** ~/.ax/agents/<name>/ directory containing all identity files */
  agentDir?: string;
  /** User ID for per-user USER.md loading */
  userId?: string;
  /**
   * Enterprise: explicit identity directory (overrides agentDir for identity files).
   * Maps to ~/.ax/agents/<agentId>/agent/ which contains SOUL.md, IDENTITY.md, etc.
   */
  identityDir?: string;
  /**
   * Enterprise: explicit user directory (overrides agentDir/users/<userId>).
   * Maps to ~/.ax/agents/<agentId>/users/<userId>/.
   */
  userDir?: string;
}

export function loadIdentityFiles(opts: IdentityLoadOptions): IdentityFiles {
  const { agentDir, userId } = opts;

  // Enterprise paths take precedence over legacy agentDir layout
  const idDir = opts.identityDir ?? agentDir;
  const load = (name: string) => idDir ? readFile(idDir, name) : '';

  // USER.md is per-user: load from explicit userDir, or agentDir/users/<userId>
  let user = '';
  if (opts.userDir) {
    user = readFile(opts.userDir, 'USER.md');
  } else if (agentDir && userId) {
    user = readFile(join(agentDir, 'users', userId), 'USER.md');
  }

  // USER_BOOTSTRAP.md is shown when the user has no USER.md yet
  const userBootstrap = (!user && idDir) ? readFile(idDir, 'USER_BOOTSTRAP.md') : '';

  return {
    agents: load('AGENTS.md'),
    soul: load('SOUL.md'),
    identity: load('IDENTITY.md'),
    user,
    bootstrap: load('BOOTSTRAP.md'),
    userBootstrap,
    heartbeat: load('HEARTBEAT.md'),
  };
}
