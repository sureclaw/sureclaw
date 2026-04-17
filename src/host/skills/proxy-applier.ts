// src/host/skills/proxy-applier.ts — Apply reconciler `desired.proxyAllowlist`
// to the ProxyDomainList using replace-style semantics keyed by agentId.
//
// The applier owns a small `prior` map so diffing is O(|desired|) and does not
// require reading back the ProxyDomainList's internal per-agent state. On each
// apply, we:
//   1. Normalize the desired set (trim + lowercase + strip trailing dot).
//   2. Diff against the prior recorded desired set for this agent.
//   3. Early-exit when both added & removed are empty (no audit noise).
//   4. Call `proxyDomainList.setAgentDomains(agentId, normalized)` — this
//      method replaces that agent's contribution atomically, so partial
//      failure is impossible.
//   5. Emit a single `proxy_allowlist_updated` audit entry summarizing the
//      diff + new total.
//   6. Update the internal `prior` map so the next call diffs correctly.

import type { ProxyDomainList } from '../proxy-domain-list.js';
import type { AuditProvider } from '../../providers/audit/types.js';
import { getLogger } from '../../logger.js';

const logger = getLogger().child({ component: 'proxy-applier' });

const normalizeDomain = (d: string): string =>
  d.trim().toLowerCase().replace(/\.$/, '');

export interface ProxyApplyResult {
  added: string[];
  removed: string[];
}

export interface ProxyApplier {
  apply(agentId: string, desired: ReadonlySet<string>): Promise<ProxyApplyResult>;
  /**
   * Drop all local state for an agent (e.g. when the agent is deleted).
   * Clears the closure-scoped `prior` baseline and removes the agent's
   * contribution from `proxyDomainList` so a later re-create starts fresh.
   * No-op for unknown agentIds.
   */
  removeAgent(agentId: string): void;
}

export interface ProxyApplierDeps {
  proxyDomainList: ProxyDomainList;
  audit?: AuditProvider;
}

export function createProxyApplier(deps: ProxyApplierDeps): ProxyApplier {
  const { proxyDomainList, audit } = deps;
  // Track prior per-agent desired sets locally so diffing is O(|desired|) and
  // doesn't require introspecting ProxyDomainList's internal Map.
  const prior = new Map<string, Set<string>>();

  return {
    async apply(agentId, desired) {
      const normalized = new Set<string>();
      for (const d of desired) {
        const n = normalizeDomain(d);
        if (n) normalized.add(n);
      }

      const previous = prior.get(agentId) ?? new Set<string>();
      const added: string[] = [];
      const removed: string[] = [];
      for (const d of normalized) if (!previous.has(d)) added.push(d);
      for (const d of previous) if (!normalized.has(d)) removed.push(d);

      if (added.length === 0 && removed.length === 0) {
        return { added, removed };
      }

      proxyDomainList.setAgentDomains(agentId, normalized);
      prior.set(agentId, normalized);

      if (audit) {
        await audit.log({
          action: 'proxy_allowlist_updated',
          args: { agentId, added, removed, total: normalized.size },
          result: 'success',
          timestamp: new Date(),
          durationMs: 0,
        });
      }
      logger.info('proxy_allowlist_updated', {
        agentId, added, removed, total: normalized.size,
      });

      return { added, removed };
    },
    removeAgent(agentId) {
      prior.delete(agentId);
      proxyDomainList.removeAgent(agentId);
    },
  };
}
