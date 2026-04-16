import type { IdentityFiles } from './prompt/types.js';

/**
 * Unpack preloaded identity files from the host's stdin payload.
 * The host reads identity from committed git state via loadIdentityFromGit().
 * No filesystem fallback — all identity lives in .ax/ under git.
 */
export function loadIdentityFiles(preloaded?: Partial<IdentityFiles>): IdentityFiles {
  return {
    agents: preloaded?.agents ?? '',
    soul: preloaded?.soul ?? '',
    identity: preloaded?.identity ?? '',
    bootstrap: preloaded?.bootstrap ?? '',
    userBootstrap: preloaded?.userBootstrap ?? '',
    heartbeat: preloaded?.heartbeat ?? '',
  };
}
