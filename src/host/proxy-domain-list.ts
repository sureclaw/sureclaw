import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'proxy-domain-list' });

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
  /** Domains approved by admin (not from skills). */
  private adminApproved = new Set<string>();
  /** Domains pending admin review. Keyed by domain for dedup. */
  private pending = new Map<string, PendingDomain>();

  isAllowed(domain: string): boolean {
    if (BUILTIN_DOMAINS.has(domain)) return true;
    if (this.adminApproved.has(domain)) return true;
    for (const domains of this.skillDomains.values()) {
      if (domains.has(domain)) return true;
    }
    return false;
  }

  /** Get a Set snapshot of all currently allowed domains (for passing to proxy). */
  getAllowedDomains(): Set<string> {
    const all = new Set(BUILTIN_DOMAINS);
    for (const domains of this.skillDomains.values()) {
      for (const d of domains) all.add(d);
    }
    for (const d of this.adminApproved) all.add(d);
    return all;
  }

  addSkillDomains(skillName: string, domains: string[]): void {
    if (domains.length === 0) return;
    this.skillDomains.set(skillName, new Set(domains));
    logger.info('skill_domains_added', { skillName, domains });
  }

  removeSkillDomains(skillName: string): void {
    this.skillDomains.delete(skillName);
  }

  /** Queue a denied domain for admin review. No-op if already allowed or pending. */
  addPending(domain: string, sessionId: string): void {
    if (this.isAllowed(domain)) return;
    if (this.pending.has(domain)) return;
    this.pending.set(domain, { domain, sessionId, timestamp: Date.now() });
    logger.info('domain_pending_approval', { domain, sessionId });
  }

  /** Admin approves a pending domain — moves to allowlist. */
  approvePending(domain: string): void {
    this.pending.delete(domain);
    this.adminApproved.add(domain);
    logger.info('domain_approved_by_admin', { domain });
  }

  /** Admin denies a pending domain — removes from queue. */
  denyPending(domain: string): void {
    this.pending.delete(domain);
    logger.info('domain_denied_by_admin', { domain });
  }

  getPending(): PendingDomain[] {
    return [...this.pending.values()];
  }
}
