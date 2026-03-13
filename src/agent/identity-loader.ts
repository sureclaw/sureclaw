import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../logger.js';
import type { IdentityFiles } from './prompt/types.js';

const logger = getLogger().child({ component: 'identity-loader' });

/** Maximum characters for any single identity file (same as OpenClaw). */
const DEFAULT_MAX_CHARS = 65536;

function readFile(dir: string, filename: string): string {
  try {
    return readFileSync(join(dir, filename), 'utf-8');
  } catch {
    return '';
  }
}

/** Truncate identity file content if it exceeds the character cap. */
function capContent(content: string, fileName: string): string {
  if (!content || content.length <= DEFAULT_MAX_CHARS) return content;
  logger.warn('identity_file_truncated', {
    file: fileName,
    originalLength: content.length,
    maxChars: DEFAULT_MAX_CHARS,
  });
  return content.slice(0, DEFAULT_MAX_CHARS);
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
  /**
   * Pre-loaded identity data from host via stdin payload (loaded from DocumentStore).
   * When provided, returns this data directly without filesystem reads.
   */
  preloaded?: IdentityFiles;
}

export function loadIdentityFiles(opts: IdentityLoadOptions): IdentityFiles {
  // When pre-loaded identity data is provided (from host via stdin payload),
  // return it directly — no filesystem reads needed.
  if (opts.preloaded) {
    return opts.preloaded;
  }

  // Filesystem fallback for backward compatibility (local dev without DB)
  const { agentDir, userId } = opts;

  // Enterprise paths take precedence over legacy agentDir layout
  const idDir = opts.identityDir ?? agentDir;
  const load = (name: string) => idDir ? capContent(readFile(idDir, name), name) : '';

  // USER.md is per-user: load from explicit userDir, or agentDir/users/<userId>
  let user = '';
  if (opts.userDir) {
    user = capContent(readFile(opts.userDir, 'USER.md'), 'USER.md');
  } else if (agentDir && userId) {
    user = capContent(readFile(join(agentDir, 'users', userId), 'USER.md'), 'USER.md');
  }

  // USER_BOOTSTRAP.md is shown when the user has no USER.md yet.
  let userBootstrap = '';
  if (!user && idDir) {
    userBootstrap = capContent(readFile(idDir, 'USER_BOOTSTRAP.md'), 'USER_BOOTSTRAP.md');
  }

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
