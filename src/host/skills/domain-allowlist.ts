// src/host/skills/domain-allowlist.ts — Per-agent proxy domain allowlist.
//
// The allowlist for a given agent's outbound traffic is:
//   BUILTIN_DOMAINS ∪ { d : some enabled skill for the agent declares d
//                           AND skill_domain_approvals has a row for
//                           (agentId, skillName, d) }
//
// Enabled = every declared credential is stored + every declared domain is
// approved. Pending/invalid skills contribute nothing.
//
// Computed at session start; the frozen Set is handed to the web-proxy so its
// per-CONNECT `allowedDomains.has(domain)` lookup stays synchronous.

import type { GetAgentSkillsDeps } from './get-agent-skills.js';
import { loadAgentProjection, loadSnapshot, sweepOrphanedRows } from './get-agent-skills.js';
import { computeSkillStates } from './state-derivation.js';

/** Package manager and common development domains — always allowed for any
 *  agent regardless of declared skills. */
export const BUILTIN_DOMAINS: ReadonlySet<string> = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'rubygems.org',
  'crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
]);

/** Normalize domain to lowercase, strip trailing dot. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Check whether `candidate` is allowed by an `allowed` set that may contain
 * both exact hostnames and `*.parent` wildcard patterns.
 *
 * Wildcard semantics match TLS RFC 6125 / browser convention: `*.foo.com`
 * matches any proper subdomain of `foo.com` (including multi-label ones like
 * `a.b.foo.com`) but NOT the bare apex `foo.com` itself. If an admin wants
 * the apex covered, they list it explicitly alongside the wildcard.
 *
 * The candidate is normalized before matching so proxy CONNECT lookups with
 * mixed case or a trailing dot still hit.
 */
export function matchesDomain(allowed: ReadonlySet<string>, candidate: string): boolean {
  const c = normalizeDomain(candidate);
  if (allowed.has(c)) return true;
  for (const entry of allowed) {
    if (!entry.startsWith('*.')) continue;
    // `*.foo.com` matches `<anything>.foo.com`: candidate must end with `.foo.com`
    // AND have strictly more characters than `.foo.com` (excludes the apex).
    const suffix = entry.slice(1); // '*.foo.com' → '.foo.com'
    if (c.length > suffix.length && c.endsWith(suffix)) return true;
  }
  return false;
}

/**
 * Compute the full set of domains an agent's outbound traffic is allowed to
 * reach. Union of BUILTIN_DOMAINS and every declared-and-approved domain on
 * an enabled skill.
 */
export async function getAllowedDomainsForAgent(
  agentId: string,
  deps: GetAgentSkillsDeps,
): Promise<Set<string>> {
  const snapshot = await loadSnapshot(agentId, deps);
  // Sweep orphaned rows so a re-added skill can't auto-enable via a prior
  // approval — the proxy allowlist must agree with the admin-UI state.
  await sweepOrphanedRows(agentId, snapshot, deps);
  const projection = await loadAgentProjection(agentId, deps);

  const states = computeSkillStates(snapshot, {
    approvedDomains: projection.approvedDomains,
    storedCredentials: projection.storedCredentials,
  });
  const enabledSkills = new Set(
    states.filter(s => s.kind === 'enabled').map(s => s.name),
  );

  const allowed = new Set<string>(BUILTIN_DOMAINS);

  for (const entry of snapshot) {
    if (!entry.ok) continue;
    if (!enabledSkills.has(entry.name)) continue;
    const skillApprovals = projection.approvalsBySkill.get(entry.name);
    if (!skillApprovals) continue;
    for (const declared of entry.frontmatter.domains) {
      const norm = normalizeDomain(declared);
      if (skillApprovals.has(norm)) allowed.add(norm);
    }
  }

  return allowed;
}
