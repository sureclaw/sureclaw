import type {
  SkillSnapshotEntry,
  SkillState,
  SkillStateKind,
  ReconcilerCurrentState,
  ReconcilerInput,
  ReconcilerOutput,
  SetupRequest,
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
  /** URL being dropped (the loser — this skill's declaration). */
  declaredUrl: string;
  /** URL already registered by an earlier skill (the winner). */
  conflictingUrl: string;
}

function enabledNameSet(states: SkillState[]): Set<string> {
  return new Set(states.filter((s) => s.kind === 'enabled').map((s) => s.name));
}

export function computeMcpDesired(
  snapshot: SkillSnapshotEntry[],
  states: SkillState[],
): {
  mcpServers: Map<string, { url: string; bearerCredential?: string }>;
  conflicts: McpConflict[];
} {
  const enabledNames = enabledNameSet(states);
  const servers = new Map<string, { url: string; bearerCredential?: string }>();
  const conflicts: McpConflict[] = [];

  for (const entry of snapshot) {
    if (!entry.ok || !enabledNames.has(entry.name)) continue;
    // Dedup within the skill — a single SKILL.md listing two entries with the
    // same name would otherwise self-conflict on its second occurrence.
    const seen = new Set<string>();
    for (const mcp of entry.frontmatter.mcpServers) {
      if (seen.has(mcp.name)) continue;
      seen.add(mcp.name);
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

export function computeProxyAllowlist(
  snapshot: SkillSnapshotEntry[],
  states: SkillState[],
): Set<string> {
  const enabledNames = enabledNameSet(states);
  const out = new Set<string>();
  for (const entry of snapshot) {
    if (!entry.ok || !enabledNames.has(entry.name)) continue;
    for (const d of entry.frontmatter.domains) out.add(d);
  }
  return out;
}

export function computeSetupQueue(
  snapshot: SkillSnapshotEntry[],
  current: Pick<ReconcilerCurrentState, 'approvedDomains' | 'storedCredentials'>,
): SetupRequest[] {
  const out: SetupRequest[] = [];
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    const fm = entry.frontmatter;
    const missingCredentials = fm.credentials
      .filter((c) => !current.storedCredentials.has(`${c.envName}@${c.scope}`))
      .map((c) => ({
        envName: c.envName,
        authType: c.authType,
        scope: c.scope,
        oauth: c.oauth,
      }));
    const unapprovedDomains = fm.domains.filter((d) => !current.approvedDomains.has(d));
    if (missingCredentials.length === 0 && unapprovedDomains.length === 0) continue;
    out.push({
      skillName: entry.name,
      description: fm.description,
      missingCredentials,
      unapprovedDomains,
      mcpServers: fm.mcpServers.map((m) => ({ name: m.name, url: m.url })),
    });
  }
  return out;
}

export function computeEvents(
  states: SkillState[],
  priorStates: ReadonlyMap<string, SkillStateKind>,
): Array<{ type: string; data: Record<string, unknown> }> {
  const events: Array<{ type: string; data: Record<string, unknown> }> = [];
  const seen = new Set<string>();

  for (const s of states) {
    seen.add(s.name);
    const prior = priorStates.get(s.name);
    if (!prior) {
      events.push({ type: 'skill.installed', data: { name: s.name } });
    }
    if (prior !== s.kind) {
      const type =
        s.kind === 'enabled'
          ? 'skill.enabled'
          : s.kind === 'pending'
            ? 'skill.pending'
            : 'skill.invalid';
      const data: Record<string, unknown> = { name: s.name };
      if (s.pendingReasons !== undefined) data.reasons = s.pendingReasons;
      if (s.error !== undefined) data.error = s.error;
      events.push({ type, data });
    }
  }
  for (const [name] of priorStates) {
    if (!seen.has(name)) {
      events.push({ type: 'skill.removed', data: { name } });
    }
  }
  return events;
}

export function reconcile(input: ReconcilerInput): ReconcilerOutput {
  const { snapshot, current } = input;

  const skills = computeSkillStates(snapshot, current);
  const { mcpServers, conflicts } = computeMcpDesired(snapshot, skills);
  const proxyAllowlist = computeProxyAllowlist(snapshot, skills);
  const setupQueue = computeSetupQueue(snapshot, current);
  const events = computeEvents(skills, current.priorSkillStates);

  for (const c of conflicts) {
    events.push({
      type: 'skill.mcp_conflict',
      data: { ...c },
    });
  }
  return {
    skills,
    desired: { mcpServers, proxyAllowlist },
    setupQueue,
    events,
  };
}
