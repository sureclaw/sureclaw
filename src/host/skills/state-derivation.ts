// src/host/skills/state-derivation.ts — Pure helpers that derive a skill's
// enable state and setup-card payload from a parsed snapshot plus the host's
// current approvals + stored credentials. Shared between `getAgentSkills`
// and `getAgentSetupQueue`.

import type {
  SkillSnapshotEntry,
  SkillState,
  SkillDerivationState,
  SetupRequest,
} from './types.js';

/** Per-skill enabled/pending/invalid. */
export function computeSkillStates(
  snapshot: SkillSnapshotEntry[],
  current: Pick<SkillDerivationState, 'approvedDomains' | 'storedCredentials'>,
): SkillState[] {
  return snapshot.map((entry) => {
    if (!entry.ok) {
      return { name: entry.name, kind: 'invalid', error: entry.error };
    }
    const fm = entry.frontmatter;
    const reasons: string[] = [];

    for (const cred of fm.credentials) {
      const key = `${entry.name}/${cred.envName}@${cred.scope}`;
      if (!current.storedCredentials.has(key)) {
        reasons.push(`missing credential ${cred.envName} (${cred.scope})`);
      }
    }
    for (const domain of fm.domains) {
      if (!current.approvedDomains.has(`${entry.name}/${domain}`)) {
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

/** Setup-card payloads for every skill with at least one unmet requirement. */
export function computeSetupQueue(
  snapshot: SkillSnapshotEntry[],
  current: Pick<SkillDerivationState, 'approvedDomains' | 'storedCredentials'>,
): SetupRequest[] {
  const out: SetupRequest[] = [];
  for (const entry of snapshot) {
    if (!entry.ok) continue;
    const fm = entry.frontmatter;
    const missingCredentials = fm.credentials
      .filter((c) => !current.storedCredentials.has(`${entry.name}/${c.envName}@${c.scope}`))
      .map((c) => ({
        envName: c.envName,
        authType: c.authType,
        scope: c.scope,
        oauth: c.oauth,
      }));
    const unapprovedDomains = fm.domains.filter((d) => !current.approvedDomains.has(`${entry.name}/${d}`));
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
