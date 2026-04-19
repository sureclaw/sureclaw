import type { SkillFrontmatter } from './frontmatter-schema.js';

/** One parsed SKILL.md or a parse failure. Input to the state-derivation helpers. */
export type SkillSnapshotEntry =
  | { name: string; ok: true; frontmatter: SkillFrontmatter; body: string }
  | { name: string; ok: false; error: string };

/** Approvals + storage state the host holds. Input alongside the snapshot
 *  for `computeSkillStates` / `computeSetupQueue`. Keys are skill-scoped so
 *  a deleted-and-re-added skill doesn't auto-satisfy from a prior skill's
 *  leftover rows. */
export interface SkillDerivationState {
  /** Approved domains, keyed by `${skillName}/${normalizedDomain}`. */
  approvedDomains: ReadonlySet<string>;
  /** Stored credentials, keyed by `${skillName}/${envName}@${scope}` (scope ∈ 'user' | 'agent'). */
  storedCredentials: ReadonlySet<string>;
}

export type SkillStateKind = 'enabled' | 'pending' | 'invalid';

export interface SkillState {
  name: string;
  kind: SkillStateKind;
  /** Human-readable reasons. Present for pending and invalid. */
  pendingReasons?: string[];
  /** Full error string for invalid. */
  error?: string;
  /** Short description surfaced in the prompt index. Present for valid frontmatter. */
  description?: string;
}

/** An entry queued onto a skill's setup card in the dashboard. */
export interface SetupRequest {
  skillName: string;
  description: string;
  missingCredentials: Array<{
    envName: string;
    authType: 'api_key' | 'oauth';
    scope: 'user' | 'agent';
    oauth?: {
      provider: string;
      clientId: string;
      authorizationUrl: string;
      tokenUrl: string;
      scopes: string[];
    };
  }>;
  unapprovedDomains: string[];
  /** Informational — user sees the URLs they are effectively authorizing. */
  mcpServers: Array<{ name: string; url: string }>;
}
