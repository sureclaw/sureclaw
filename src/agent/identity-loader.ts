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
}

export function loadIdentityFiles(opts: IdentityLoadOptions): IdentityFiles {
  const { agentDir, userId } = opts;

  const load = (name: string) => agentDir ? readFile(agentDir, name) : '';

  // USER.md is per-user: load from agentDir/users/<userId>/USER.md
  let user = '';
  if (agentDir && userId) {
    user = readFile(join(agentDir, 'users', userId), 'USER.md');
  }

  // USER_BOOTSTRAP.md is shown when the user has no USER.md yet
  const userBootstrap = (!user && agentDir) ? readFile(agentDir, 'USER_BOOTSTRAP.md') : '';

  return {
    agents: load('AGENTS.md'),
    soul: load('SOUL.md'),
    identity: load('IDENTITY.md'),
    user,
    bootstrap: load('BOOTSTRAP.md'),
    userBootstrap,
  };
}
