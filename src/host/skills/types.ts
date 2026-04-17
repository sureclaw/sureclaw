import type { SkillFrontmatter } from './frontmatter-schema.js';

/** One parsed SKILL.md or a parse failure. Input to the reconciler. */
export type SkillSnapshotEntry =
  | { name: string; ok: true; frontmatter: SkillFrontmatter; body: string }
  | { name: string; ok: false; error: string };

/** Approvals + storage state the host already holds. */
export interface ReconcilerCurrentState {
  /** Domains the user has approved on the setup card, by exact host match. */
  approvedDomains: ReadonlySet<string>;
  /** Credentials currently stored, keyed by `${envName}@${scope}` ('user' or 'agent'). */
  storedCredentials: ReadonlySet<string>;
  /** MCP servers currently registered, keyed by name. */
  registeredMcpServers: ReadonlyMap<string, { url: string }>;
  /** Prior reconcile's enable state per skill — drives event diffs. */
  priorSkillStates: ReadonlyMap<string, SkillStateKind>;
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

/** The reconciler's verdict. Effects live with the caller (phase 2+). */
export interface ReconcilerOutput {
  skills: SkillState[];
  desired: {
    /** MCP servers to register after this cycle, keyed by name. */
    mcpServers: Map<string, { url: string; bearerCredential?: string }>;
    /** Union of domains from enabled skills, intersected with approved domains. */
    proxyAllowlist: Set<string>;
  };
  /** Setup cards to surface/update in the dashboard. */
  setupQueue: SetupRequest[];
  /** Events to emit on the event bus. Dot-namespaced types. */
  events: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface ReconcilerInput {
  snapshot: SkillSnapshotEntry[];
  current: ReconcilerCurrentState;
}
