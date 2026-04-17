import type {
  SkillSnapshotEntry,
  SkillState,
  ReconcilerCurrentState,
} from './types.js';

/**
 * Per-skill enabled/pending/invalid. Exposed as a named export for
 * focused testing; the top-level `reconcile` composes this with the
 * rest of the pipeline.
 */
export function computeSkillStates(
  snapshot: SkillSnapshotEntry[],
  current: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>,
): SkillState[] {
  return snapshot.map((entry) => {
    if (!entry.ok) {
      return { name: entry.name, kind: 'invalid', error: entry.error };
    }
    const fm = entry.frontmatter;
    const reasons: string[] = [];

    for (const cred of fm.credentials) {
      const key = `${cred.envName}@${cred.scope}`;
      if (!current.storedCredentials.has(key)) {
        reasons.push(`missing credential ${cred.envName} (${cred.scope})`);
      }
    }
    for (const domain of fm.domains) {
      if (!current.approvedDomains.has(domain)) {
        reasons.push(`domain not approved: ${domain}`);
      }
    }
    if (reasons.length === 0) {
      return { name: entry.name, kind: 'enabled', description: fm.description };
    }
    return {
      name: entry.name,
      kind: 'pending',
      pendingReasons: reasons,
      description: fm.description,
    };
  });
}

export interface McpConflict {
  skillName: string;
  mcpName: string;
  declaredUrl: string;
  conflictingUrl: string;
}

export function computeMcpDesired(
  snapshot: SkillSnapshotEntry[],
  states: SkillState[],
): {
  mcpServers: Map<string, { url: string; bearerCredential?: string }>;
  conflicts: McpConflict[];
} {
  const enabledNames = new Set(states.filter((s) => s.kind === 'enabled').map((s) => s.name));
  const servers = new Map<string, { url: string; bearerCredential?: string }>();
  const conflicts: McpConflict[] = [];

  for (const entry of snapshot) {
    if (!entry.ok || !enabledNames.has(entry.name)) continue;
    for (const mcp of entry.frontmatter.mcpServers) {
      const existing = servers.get(mcp.name);
      if (existing) {
        if (existing.url !== mcp.url) {
          conflicts.push({
            skillName: entry.name,
            mcpName: mcp.name,
            declaredUrl: mcp.url,
            conflictingUrl: existing.url,
          });
        }
        continue;
      }
      servers.set(mcp.name, {
        url: mcp.url,
        bearerCredential: mcp.credential,
      });
    }
  }
  return { mcpServers: servers, conflicts };
}
