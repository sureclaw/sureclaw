import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'proxy-domain-list' });

/** Normalize domain to lowercase, strip trailing dot. */
const normalizeDomain = (domain: string): string =>
  domain.trim().toLowerCase().replace(/\.$/, '');

/** Package manager and common development domains — always allowed. */
const BUILTIN_DOMAINS = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org',
  'rubygems.org',
  'crates.io', 'static.crates.io',
  'proxy.golang.org', 'sum.golang.org',
  'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
]);

interface PendingDomain {
  domain: string;
  sessionId: string;
  timestamp: number;
}

/**
 * Maintains the proxy domain allowlist from installed skill manifests.
 *
 * Domains are allowed if they appear in:
 * 1. BUILTIN_DOMAINS (package managers, GitHub)
 * 2. Skill-declared domains (from manifest capabilities.domains)
 * 3. Admin-approved domains (via approvePending)
 *
 * Unknown domains are denied immediately and added to a pending queue
 * for admin review on the dashboard.
 */
export class ProxyDomainList {
  /** skill name → Set<domain> */
  private skillDomains = new Map<string, Set<string>>();
  /** agentId → Set<domain> — phase 4 per-agent skill contribution. */
  private agentDomains = new Map<string, Set<string>>();
  /** Domains approved by admin (not from skills). */
  private adminApproved = new Set<string>();
  /** Domains pending admin review. Keyed by domain for dedup. */
  private pending = new Map<string, PendingDomain>();
  /** Merged cache of all allowed domains — invalidated on changes, rebuilt lazily. */
  private merged: Set<string> | null = null;

  isAllowed(domain: string): boolean {
    if (!this.merged) this.rebuildMerged();
    return this.merged!.has(normalizeDomain(domain));
  }

  private rebuildMerged(): void {
    const all = new Set(BUILTIN_DOMAINS);
    for (const domains of this.skillDomains.values()) {
      for (const d of domains) all.add(d);
    }
    for (const domains of this.agentDomains.values()) {
      for (const d of domains) all.add(d);
    }
    for (const d of this.adminApproved) all.add(d);
    this.merged = all;
  }

  /** Get a Set snapshot of all currently allowed domains. */
  getAllowedDomains(): Set<string> {
    if (!this.merged) this.rebuildMerged();
    return new Set(this.merged!);
  }

  addSkillDomains(skillName: string, domains: string[]): void {
    const normalized = new Set(domains.map(normalizeDomain).filter(Boolean));
    if (normalized.size === 0) {
      this.skillDomains.delete(skillName);
    } else {
      this.skillDomains.set(skillName, normalized);
    }
    this.merged = null;
    logger.info('skill_domains_added', { skillName, domains: [...normalized] });
  }

  removeSkillDomains(skillName: string): void {
    this.skillDomains.delete(skillName);
    this.merged = null;
  }

  /**
   * Phase 4: replace this agent's entire domain contribution in one call.
   * Empty iterable deletes the agent's entry. Normalizes each domain (trim +
   * lowercase + strip trailing dot) and drops blanks.
   */
  setAgentDomains(agentId: string, domains: Iterable<string>): void {
    const normalized = new Set<string>();
    for (const d of domains) {
      const n = normalizeDomain(d);
      if (n) normalized.add(n);
    }
    if (normalized.size === 0) {
      this.agentDomains.delete(agentId);
    } else {
      this.agentDomains.set(agentId, normalized);
    }
    this.merged = null;
    logger.info('agent_domains_set', { agentId, domains: [...normalized] });
  }

  /** Phase 4: drop an agent's entire contribution (e.g. agent deleted). */
  removeAgent(agentId: string): void {
    this.agentDomains.delete(agentId);
    this.merged = null;
  }

  /** Queue a denied domain for admin review. No-op if already allowed or pending. */
  addPending(domain: string, sessionId: string): void {
    const normalized = normalizeDomain(domain);
    if (this.isAllowed(normalized)) return;
    if (this.pending.has(normalized)) return;
    this.pending.set(normalized, { domain: normalized, sessionId, timestamp: Date.now() });
    logger.info('domain_pending_approval', { domain: normalized, sessionId });
  }

  /** Admin approves a pending domain — moves to allowlist. */
  approvePending(domain: string): void {
    const normalized = normalizeDomain(domain);
    this.pending.delete(normalized);
    this.adminApproved.add(normalized);
    this.merged = null;
    logger.info('domain_approved_by_admin', { domain: normalized });
  }

  /** Admin denies a pending domain — removes from queue. */
  denyPending(domain: string): void {
    const normalized = normalizeDomain(domain);
    this.pending.delete(normalized);
    logger.info('domain_denied_by_admin', { domain: normalized });
  }

  getPending(): PendingDomain[] {
    return [...this.pending.values()];
  }
}
