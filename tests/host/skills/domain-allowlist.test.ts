import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_DOMAINS,
  getAllowedDomainsForAgent,
  matchesDomain,
  normalizeDomain,
} from '../../../src/host/skills/domain-allowlist.js';
import { createSnapshotCache } from '../../../src/host/skills/snapshot-cache.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';
import type {
  SkillCredGetInput,
  SkillCredPutInput,
  SkillCredRow,
  SkillCredStore,
} from '../../../src/host/skills/skill-cred-store.js';
import type { SkillDomainStore } from '../../../src/host/skills/skill-domain-store.js';

// ── Git bare-repo seed helpers ──

function initBareRepo(bareRepoPath: string): void {
  fs.mkdirSync(bareRepoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepoPath, 'HEAD'), 'ref: refs/heads/main\n');
}

function seedRepo(bareRepoPath: string, files: Record<string, string>): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-dal-work-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(workTree, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const runCmd = (args: string[]) =>
      execFileSync('git', args, { cwd: workTree, encoding: 'utf-8', stdio: 'pipe' });
    runCmd(['init', '-b', 'main']);
    runCmd(['config', 'user.name', 'test']);
    runCmd(['config', 'user.email', 'test@local']);
    runCmd(['remote', 'add', 'origin', bareRepoPath]);
    runCmd(['add', '-A']);
    runCmd(['commit', '-m', 'seed']);
    runCmd(['push', '-u', 'origin', 'main']);
  } finally {
    try {
      fs.rmSync(workTree, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

// ── Stubs ──

class InMemorySkillCredStore implements SkillCredStore {
  private store = new Map<string, string>();
  private key(a: string, s: string, e: string, u: string): string {
    return `${a}::${s}::${e}::${u}`;
  }
  async put(input: SkillCredPutInput): Promise<void> {
    this.store.set(this.key(input.agentId, input.skillName, input.envName, input.userId), input.value);
  }
  async get(_input: SkillCredGetInput): Promise<string | null> { return null; }
  async listForAgent(agentId: string): Promise<SkillCredRow[]> {
    const rows: SkillCredRow[] = [];
    for (const [k, value] of this.store.entries()) {
      const [aid, skillName, envName, userId] = k.split('::');
      if (aid !== agentId) continue;
      rows.push({ skillName, envName, userId, value });
    }
    return rows;
  }
  async listEnvNames(): Promise<Set<string>> { return new Set(); }
  async deleteForSkill(agentId: string, skillName: string): Promise<void> {
    for (const k of [...this.store.keys()]) {
      const [aid, sName] = k.split('::');
      if (aid === agentId && sName === skillName) this.store.delete(k);
    }
  }
  seed(agentId: string, skillName: string, envName: string, userId: string, value: string): void {
    this.store.set(this.key(agentId, skillName, envName, userId), value);
  }
}

class InMemorySkillDomainStore implements SkillDomainStore {
  private rows: Array<{ agentId: string; skillName: string; domain: string }> = [];
  async approve(input: { agentId: string; skillName: string; domain: string }): Promise<void> {
    const exists = this.rows.some(r =>
      r.agentId === input.agentId && r.skillName === input.skillName && r.domain === input.domain);
    if (!exists) this.rows.push({ ...input });
  }
  async listForAgent(agentId: string): Promise<Array<{ skillName: string; domain: string }>> {
    return this.rows
      .filter(r => r.agentId === agentId)
      .map(r => ({ skillName: r.skillName, domain: r.domain }));
  }
  async deleteForSkill(agentId: string, skillName: string): Promise<void> {
    this.rows = this.rows.filter(r => !(r.agentId === agentId && r.skillName === skillName));
  }
  seed(agentId: string, skillName: string, domain: string): void {
    this.rows.push({ agentId, skillName, domain });
  }
}

// ── Test fixtures ──

const linearSkill = `---
name: linear
description: Query Linear issues.
credentials:
  - envName: LINEAR_TOKEN
    authType: api_key
    scope: user
domains:
  - api.linear.app
---

# Linear
`;

const weatherSkill = `---
name: weather
description: Weather forecast.
domains:
  - api.weather.gov
  - cdn.weather.gov
---

# Weather
`;

const brokenSkill = `---
name: broken
# missing description
---

# Broken
`;

const pendingSkill = `---
name: pending-skill
description: Has an unapproved domain.
domains:
  - api.pending.example
---

# Pending
`;

// ── Tests ──

describe('normalizeDomain', () => {
  it('trims, lowercases, and strips trailing dots', () => {
    expect(normalizeDomain('  API.Linear.App.  ')).toBe('api.linear.app');
  });
});

describe('matchesDomain', () => {
  it('returns true for exact matches', () => {
    const allowed = new Set(['api.linear.app', 'github.com']);
    expect(matchesDomain(allowed, 'api.linear.app')).toBe(true);
    expect(matchesDomain(allowed, 'github.com')).toBe(true);
  });

  it('returns false for domains not in the set', () => {
    const allowed = new Set(['api.linear.app']);
    expect(matchesDomain(allowed, 'api.slack.com')).toBe(false);
  });

  it('wildcards match any subdomain of the declared parent', () => {
    // `*.salesforce.com` covers `login.salesforce.com`, `acme.my.salesforce.com`,
    // etc. — the classic TLS-style coverage pattern for multi-tenant vendors.
    const allowed = new Set(['*.salesforce.com']);
    expect(matchesDomain(allowed, 'login.salesforce.com')).toBe(true);
    expect(matchesDomain(allowed, 'acme.my.salesforce.com')).toBe(true);
    expect(matchesDomain(allowed, 'deep.sub.domain.salesforce.com')).toBe(true);
  });

  it('wildcards do NOT match the bare apex', () => {
    // `*.foo.com` must NOT match `foo.com` itself — an apex match requires
    // the admin to list `foo.com` explicitly. This matches every major TLS
    // wildcard implementation (RFC 6125, browsers, curl).
    const allowed = new Set(['*.salesforce.com']);
    expect(matchesDomain(allowed, 'salesforce.com')).toBe(false);
  });

  it('wildcards do NOT match sibling domains', () => {
    const allowed = new Set(['*.salesforce.com']);
    expect(matchesDomain(allowed, 'salesforce.com.evil.net')).toBe(false);
    expect(matchesDomain(allowed, 'not-salesforce.com')).toBe(false);
  });

  it('normalizes the candidate before matching', () => {
    // Proxy may receive `FOO.SALESFORCE.COM` with mixed case or a trailing dot.
    const allowed = new Set(['*.salesforce.com', 'api.linear.app']);
    expect(matchesDomain(allowed, 'Foo.Salesforce.Com.')).toBe(true);
    expect(matchesDomain(allowed, 'API.LINEAR.APP')).toBe(true);
  });

  it('handles mixed exact + wildcard in the same set', () => {
    const allowed = new Set(['login.salesforce.com', '*.my.salesforce.com']);
    expect(matchesDomain(allowed, 'login.salesforce.com')).toBe(true);
    expect(matchesDomain(allowed, 'acme.my.salesforce.com')).toBe(true);
    expect(matchesDomain(allowed, 'api.salesforce.com')).toBe(false);
  });
});

describe('getAllowedDomainsForAgent', () => {
  let bareRepoPath: string;

  beforeEach(() => {
    bareRepoPath = path.join(
      os.tmpdir(),
      `ax-dal-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    );
    initBareRepo(bareRepoPath);
  });

  afterEach(() => {
    try {
      fs.rmSync(bareRepoPath, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  function makeAgentSkillsDeps(credStore: SkillCredStore, domainStore: SkillDomainStore) {
    return {
      skillCredStore: credStore,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 }),
    };
  }

  it('BUILTIN_DOMAINS are always included', async () => {
    seedRepo(bareRepoPath, { 'README.md': '# empty\n' });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const deps = makeAgentSkillsDeps(credStore, domainStore);

    const allowed = await getAllowedDomainsForAgent('agent-1', deps);
    expect(allowed.has('registry.npmjs.org')).toBe(true);
    expect(allowed.has('pypi.org')).toBe(true);
    expect(allowed.has('github.com')).toBe(true);
    for (const d of BUILTIN_DOMAINS) expect(allowed.has(d)).toBe(true);
  });

  it('only enabled skills contribute their declared domains', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
      '.ax/skills/weather/SKILL.md': weatherSkill,
      '.ax/skills/pending-skill/SKILL.md': pendingSkill,
    });

    const credStore = new InMemorySkillCredStore();
    credStore.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok');

    const domainStore = new InMemorySkillDomainStore();
    // Approve linear's domain AND weather's domains so both are enabled.
    domainStore.seed('agent-1', 'linear', 'api.linear.app');
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');
    domainStore.seed('agent-1', 'weather', 'cdn.weather.gov');
    // Don't approve pending-skill's domain — it stays pending, so its declared
    // domain must NOT appear in the allowlist.
    // (Even though the approval row itself exists below.)

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.has('api.linear.app')).toBe(true);
    expect(allowed.has('api.weather.gov')).toBe(true);
    expect(allowed.has('cdn.weather.gov')).toBe(true);
  });

  it('pending skill does not contribute to the allowlist', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/pending-skill/SKILL.md': pendingSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Even with an approval row, the skill's state is pending (domain not
    // approved), so its domains are excluded.
    // Actually: this skill's pendingness comes from the declared domain being
    // unapproved. So before any approval, the skill is pending; the declared
    // domain isn't contributed.

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.has('api.pending.example')).toBe(false);
  });

  it('invalid skill frontmatter contributes nothing', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/broken/SKILL.md': brokenSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'broken', 'evil.example');

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    // Builtins present; broken's "evil.example" must NOT be in.
    expect(allowed.has('evil.example')).toBe(false);
  });

  it('approval without a matching skill declaration does not leak into the allowlist', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Weather declares api.weather.gov + cdn.weather.gov. Approve one of them
    // plus an extra row that weather does NOT declare.
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');
    domainStore.seed('agent-1', 'weather', 'cdn.weather.gov');
    domainStore.seed('agent-1', 'weather', 'not-declared.example');

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.has('api.weather.gov')).toBe(true);
    expect(allowed.has('cdn.weather.gov')).toBe(true);
    // Approval without a declaration = not in the allowlist.
    expect(allowed.has('not-declared.example')).toBe(false);
  });

  it('partially-approved skill stays pending → none of its domains contribute', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Only approve one of weather's two declared domains → skill is pending.
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    // Skill isn't enabled, so neither declared domain lands on the agent
    // allowlist — even the one with an approval row. "Enabled skill" is the
    // prerequisite for contributing domains.
    expect(allowed.has('api.weather.gov')).toBe(false);
    expect(allowed.has('cdn.weather.gov')).toBe(false);
  });

  it('empty agent (no skills) returns only builtins', async () => {
    seedRepo(bareRepoPath, { 'README.md': '# unrelated\n' });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.size).toBe(BUILTIN_DOMAINS.size);
    for (const d of BUILTIN_DOMAINS) expect(allowed.has(d)).toBe(true);
  });

  it('approvals scoped to a different agent are ignored', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Approvals belong to agent-2, not agent-1.
    domainStore.seed('agent-2', 'weather', 'api.weather.gov');
    domainStore.seed('agent-2', 'weather', 'cdn.weather.gov');

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.has('api.weather.gov')).toBe(false);
    expect(allowed.has('cdn.weather.gov')).toBe(false);
  });

  it('domains are normalized (lowercase, trailing-dot-stripped)', async () => {
    // Weather declares already-normalized values; approvals seed with an
    // un-normalized form. Both should still match.
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const credStore = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'weather', '  API.WEATHER.GOV.  ');
    domainStore.seed('agent-1', 'weather', 'cdn.weather.gov');

    const deps = makeAgentSkillsDeps(credStore, domainStore);
    const allowed = await getAllowedDomainsForAgent('agent-1', deps);

    expect(allowed.has('api.weather.gov')).toBe(true);
    expect(allowed.has('cdn.weather.gov')).toBe(true);
  });
});
