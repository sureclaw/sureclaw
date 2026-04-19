import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getAgentSkills,
  getAgentSetupQueue,
  loadSnapshot,
} from '../../../src/host/skills/get-agent-skills.js';
import { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';
import { createSnapshotCache } from '../../../src/host/skills/snapshot-cache.js';
import { buildSnapshotFromBareRepo } from '../../../src/host/skills/snapshot.js';
import { computeSkillStates } from '../../../src/host/skills/state-derivation.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';
import type {
  SkillCredGetInput,
  SkillCredPutInput,
  SkillCredRow,
  SkillCredStore,
} from '../../../src/host/skills/skill-cred-store.js';
import type { SkillDomainStore } from '../../../src/host/skills/skill-domain-store.js';

// ── Test helpers (mirror snapshot.test.ts pattern) ──

function runGitCommands(
  cwd: string,
  commands: Array<{ args: string[]; name: string }>,
  critical: string[],
): void {
  for (const cmd of commands) {
    try {
      execFileSync('git', cmd.args, { cwd, encoding: 'utf-8', stdio: 'pipe' });
    } catch (err) {
      if (critical.includes(cmd.name)) {
        throw new Error(
          `${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

function initBareRepo(bareRepoPath: string): void {
  fs.mkdirSync(bareRepoPath, { recursive: true });
  execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'pipe' });
  fs.writeFileSync(path.join(bareRepoPath, 'HEAD'), 'ref: refs/heads/main\n');
}

function seedRepo(bareRepoPath: string, files: Record<string, string>): void {
  const workTree = fs.mkdtempSync(path.join(os.tmpdir(), 'ax-gas-work-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = path.join(workTree, relPath);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    runGitCommands(
      workTree,
      [
        { args: ['init', '-b', 'main'], name: 'git init' },
        { args: ['config', 'user.name', 'test'], name: 'git config user.name' },
        { args: ['config', 'user.email', 'test@local'], name: 'git config user.email' },
        { args: ['remote', 'add', 'origin', bareRepoPath], name: 'git remote add' },
        { args: ['add', '-A'], name: 'git add' },
        { args: ['commit', '-m', 'seed'], name: 'git commit' },
        { args: ['push', '-u', 'origin', 'main'], name: 'git push' },
      ],
      ['git init', 'git add', 'git commit', 'git push'],
    );
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
  /** Map<`${agentId}::${skillName}::${envName}::${userId}`, value> */
  private store = new Map<string, string>();

  private key(agentId: string, skillName: string, envName: string, userId: string): string {
    return `${agentId}::${skillName}::${envName}::${userId}`;
  }

  async put(input: SkillCredPutInput): Promise<void> {
    this.store.set(this.key(input.agentId, input.skillName, input.envName, input.userId), input.value);
  }
  async get(input: SkillCredGetInput): Promise<string | null> {
    const exact = this.store.get(this.key(input.agentId, input.skillName, input.envName, input.userId));
    if (exact !== undefined) return exact;
    if (input.userId === '') return null;
    return this.store.get(this.key(input.agentId, input.skillName, input.envName, '')) ?? null;
  }
  async listForAgent(agentId: string): Promise<SkillCredRow[]> {
    const out: SkillCredRow[] = [];
    for (const [k, value] of this.store.entries()) {
      const [aid, skillName, envName, userId] = k.split('::');
      if (aid !== agentId) continue;
      out.push({ skillName, envName, userId, value });
    }
    return out;
  }
  async listEnvNames(agentId: string): Promise<Set<string>> {
    const out = new Set<string>();
    for (const k of this.store.keys()) {
      const [aid, , envName] = k.split('::');
      if (aid === agentId) out.add(envName);
    }
    return out;
  }
  async deleteForSkill(agentId: string, skillName: string): Promise<void> {
    for (const k of [...this.store.keys()]) {
      const [aid, sName] = k.split('::');
      if (aid === agentId && sName === skillName) this.store.delete(k);
    }
  }

  /** Helper for tests: seed a row for this agent by scope + userId. */
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
  async listForAgent(agentId: string) {
    return this.rows
      .filter(r => r.agentId === agentId)
      .map(r => ({ skillName: r.skillName, domain: r.domain }));
  }
  async deleteForSkill(agentId: string, skillName: string): Promise<void> {
    this.rows = this.rows.filter(r => !(r.agentId === agentId && r.skillName === skillName));
  }
  /** Helper for tests: seed an approval row directly. */
  seed(agentId: string, skillName: string, domain: string): void {
    this.rows.push({ agentId, skillName, domain });
  }
}

describe('getAgentSkills', () => {
  let bareRepoPath: string;

  beforeEach(() => {
    bareRepoPath = path.join(
      os.tmpdir(),
      `ax-gas-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
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
---

# Weather
`;

  const brokenSkill = `---
name: broken
# missing description
---

# Broken
`;

  it('returns enabled/pending/invalid states for a realistic mix', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
      '.ax/skills/weather/SKILL.md': weatherSkill,
      '.ax/skills/broken/SKILL.md': brokenSkill,
    });

    const store = new InMemorySkillCredStore();
    // Store LINEAR_TOKEN under a user scope — prefix match makes it visible as @user.
    store.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok-123');

    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    const states = await getAgentSkills('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    const byName = new Map(states.map((s) => [s.name, s]));
    expect(byName.get('linear')?.kind).toBe('enabled');
    expect(byName.get('weather')?.kind).toBe('enabled');
    expect(byName.get('broken')?.kind).toBe('invalid');
    expect(byName.get('broken')?.error).toBeTruthy();
  });

  it('reports pending when a credential is missing', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const states = await getAgentSkills('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(states).toHaveLength(1);
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('LINEAR_TOKEN'))).toBe(true);
  });

  it('reports pending when a domain is unapproved', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // api.weather.gov not approved.

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const states = await getAgentSkills('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(states).toHaveLength(1);
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('api.weather.gov'))).toBe(true);
  });

  it('returns [] when the repo has no skills', async () => {
    seedRepo(bareRepoPath, { 'README.md': '# unrelated\n' });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const states = await getAgentSkills('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-xyz',
      snapshotCache: cache,
    });
    expect(states).toEqual([]);
  });

  it('cache hit on the same HEAD sha avoids re-walking the bare repo', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    let repoPathCalls = 0;
    const getBareRepoPath = async () => {
      repoPathCalls += 1;
      return bareRepoPath;
    };

    const deps = {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath,
      probeHead: async () => 'sha-stable',
      snapshotCache: cache,
    };

    const first = await getAgentSkills('agent-1', deps);
    expect(repoPathCalls).toBe(1);
    expect(first).toHaveLength(1);

    // Delete the bare repo entirely. If the cache doesn't hit, the second call
    // would fail to open the repo — this makes the "no I/O" assertion robust
    // even across implementations that might lazily stat the path.
    fs.rmSync(bareRepoPath, { recursive: true, force: true });

    const second = await getAgentSkills('agent-1', deps);
    expect(repoPathCalls).toBe(1);
    expect(second.map((s) => s.name)).toEqual(first.map((s) => s.name));
  });

  it('loadSnapshot registers skill-declared MCP servers with mcpManager on cache miss', async () => {
    // Regression: skill-declared `mcpServers[]` frontmatter must flow into
    // the host-global mcpManager registry or `discoverAllTools` finds
    // nothing to probe and no tool modules get committed.
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': `---
name: linear
description: Query Linear.
mcpServers:
  - name: linear
    url: https://mcp.linear.app/sse
---

# Linear
`,
    });

    const mcpManager = new McpConnectionManager();
    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    await loadSnapshot('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-fresh',
      snapshotCache: cache,
      mcpManager,
    });

    const registered = mcpManager.listServers('agent-1');
    expect(registered.map(s => s.name)).toEqual(['linear']);
    expect(registered[0].url).toBe('https://mcp.linear.app/sse');
    expect(mcpManager.getServerMeta('agent-1', 'linear')?.source).toBe('skill');
  });

  it('loadSnapshot re-registers MCP servers on cache hit too (survives mcpManager restart)', async () => {
    // After a host restart, the snapshot cache starts cold. Once the first
    // read lands, its `snapshotCache.put` seeds the cache. But if a later
    // read hits the cache (same HEAD), the mcpManager registry must still
    // be re-asserted — the registry is in-memory and wiped on restart,
    // independent of the snapshot cache.
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': `---
name: linear
description: Query Linear.
mcpServers:
  - name: linear
    url: https://mcp.linear.app/sse
---

# Linear
`,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const deps = {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-stable',
      snapshotCache: cache,
    };

    // Prime the cache with mcpManager #1.
    const mgr1 = new McpConnectionManager();
    await loadSnapshot('agent-1', { ...deps, mcpManager: mgr1 });
    expect(mgr1.listServers('agent-1')).toHaveLength(1);

    // Simulate a host restart: new (empty) mcpManager, cache still warm.
    const mgr2 = new McpConnectionManager();
    await loadSnapshot('agent-1', { ...deps, mcpManager: mgr2 });
    expect(mgr2.listServers('agent-1').map(s => s.name)).toEqual(['linear']);
  });

  it('loadSnapshot no-ops on mcpManager when not provided (backwards-compat)', async () => {
    // GetAgentSkillsDeps.mcpManager is optional — test fixtures that don't
    // care about registry side-effects should still work.
    seedRepo(bareRepoPath, { '.ax/skills/linear/SKILL.md': linearSkill });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    // No mcpManager in deps — must not throw.
    await expect(
      loadSnapshot('agent-1', {
        skillCredStore: store,
        skillDomainStore: domainStore,
        getBareRepoPath: async () => bareRepoPath,
        probeHead: async () => 'sha-abc',
        snapshotCache: cache,
      }),
    ).resolves.toBeTruthy();
  });

  it('cache miss when HEAD sha changes even for the same agent', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    let repoPathCalls = 0;
    const getBareRepoPath = async () => {
      repoPathCalls += 1;
      return bareRepoPath;
    };

    let currentSha = 'sha-1';
    const deps = {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath,
      probeHead: async () => currentSha,
      snapshotCache: cache,
    };

    await getAgentSkills('agent-1', deps);
    expect(repoPathCalls).toBe(1);

    currentSha = 'sha-2';
    await getAgentSkills('agent-1', deps);
    expect(repoPathCalls).toBe(2);
  });

  it('matches computeSkillStates on the same snapshot + current state', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
      '.ax/skills/weather/SKILL.md': weatherSkill,
      '.ax/skills/broken/SKILL.md': brokenSkill,
    });

    const store = new InMemorySkillCredStore();
    // Linear: creds OK (stored at user:ax:alice → matches LINEAR_TOKEN@user).
    store.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok');

    const domainStore = new InMemorySkillDomainStore();
    // Linear's api.linear.app approved; weather's api.weather.gov NOT approved.
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    const liveStates = await getAgentSkills('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-1',
      snapshotCache: cache,
    });

    // Re-run the same derivation directly against the underlying helpers.
    const snapshot = await buildSnapshotFromBareRepo(bareRepoPath, 'refs/heads/main');
    const approvedDomains = new Set<string>();
    for (const row of await domainStore.listForAgent('agent-1')) {
      approvedDomains.add(`${row.skillName}/${row.domain}`);
    }
    const storedCredentials = new Set<string>();
    for (const row of await store.listForAgent('agent-1')) {
      const scope = row.userId === '' ? 'agent' : 'user';
      storedCredentials.add(`${row.skillName}/${row.envName}@${scope}`);
    }

    const derived = computeSkillStates(snapshot, { approvedDomains, storedCredentials });

    const liveByName = new Map(liveStates.map((s) => [s.name, s]));
    const derivedByName = new Map(derived.map((s) => [s.name, s]));

    expect([...liveByName.keys()].sort()).toEqual([...derivedByName.keys()].sort());

    for (const name of liveByName.keys()) {
      const live = liveByName.get(name)!;
      const d = derivedByName.get(name)!;
      expect(live.kind).toBe(d.kind);
      expect(live.description).toBe(d.description);
      expect(live.pendingReasons ?? []).toEqual(d.pendingReasons ?? []);
      expect(live.error).toBe(d.error);
    }

    // Sanity: the mix actually is a mix — enabled + pending + invalid all present.
    const kinds = new Set(liveStates.map((s) => s.kind));
    expect(kinds).toEqual(new Set(['enabled', 'pending', 'invalid']));
  });
});

describe('getAgentSetupQueue', () => {
  let bareRepoPath: string;

  beforeEach(() => {
    bareRepoPath = path.join(
      os.tmpdir(),
      `ax-gasq-test-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
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
---

# Weather
`;

  const brokenSkill = `---
name: broken
# missing description
---

# Broken
`;

  it('emits one setup card for the only pending skill in a mix', async () => {
    seedRepo(bareRepoPath, {
      // linear — creds + domain already satisfied → enabled → no card.
      '.ax/skills/linear/SKILL.md': linearSkill,
      // weather — domain NOT approved → pending → card.
      '.ax/skills/weather/SKILL.md': weatherSkill,
      // broken — invalid frontmatter → skipped (neither enabled nor a card).
      '.ax/skills/broken/SKILL.md': brokenSkill,
    });

    const store = new InMemorySkillCredStore();
    store.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok-123');

    const domainStore = new InMemorySkillDomainStore();
    // Linear's domain is approved → no unapproved domain entry.
    // Weather's api.weather.gov is NOT approved → surfaces as unapproved.
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });

    const queue = await getAgentSetupQueue('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('weather');
    expect(queue[0].missingCredentials).toEqual([]);
    expect(queue[0].unapprovedDomains).toEqual(['api.weather.gov']);
  });

  it('returns [] when no skills are pending', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
    });

    const store = new InMemorySkillCredStore();
    store.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok');

    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const queue = await getAgentSetupQueue('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(queue).toEqual([]);
  });

  it('re-added skill surfaces a setup card because orphan-sweep cleared its rows while it was absent', async () => {
    // Regression for the admin-reported bug: delete `linear`, re-add `linear`,
    // skill shows Enabled without appearing in Approvals.
    //
    // Lifecycle being simulated:
    //   T0 — admin approved 'linear' (rows written)
    //   T1 — SKILL.md removed from the workspace → admin viewed state → orphan
    //        sweep cleared the rows because 'linear' was absent from the snapshot
    //   T2 — SKILL.md committed back → projection is empty → setup card surfaces
    //
    // Step T1 is what the tests below simulate with the explicit
    // `getAgentSetupQueue` call on the empty repo: the sweep runs there.
    seedRepo(bareRepoPath, { 'README.md': '# empty\n' });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Prior-life rows.
    store.seed('agent-1', 'linear', 'LINEAR_TOKEN', 'alice', 'tok-from-previous-life');
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const deps = {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-empty',
      snapshotCache: cache,
    };

    // T1: admin views state while 'linear' is absent → sweep deletes its rows.
    await getAgentSetupQueue('agent-1', deps);
    expect(await store.listForAgent('agent-1')).toHaveLength(0);
    expect(await domainStore.listForAgent('agent-1')).toHaveLength(0);

    // T2: re-add the skill. Rows are gone; the setup card should reappear.
    fs.rmSync(bareRepoPath, { recursive: true, force: true });
    initBareRepo(bareRepoPath);
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
    });
    cache.clear();
    const queue = await getAgentSetupQueue('agent-1', {
      ...deps,
      probeHead: async () => 'sha-readded',
    });
    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(queue[0].unapprovedDomains).toEqual(['api.linear.app']);
  });

  it('orphan sweep deletes rows for skills absent from the current snapshot', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/weather/SKILL.md': weatherSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // 'weather' is in the snapshot; 'ghost' is not.
    store.seed('agent-1', 'ghost', 'GHOST_KEY', 'alice', 'zombie');
    store.seed('agent-1', 'weather', 'WEATHER_KEY', 'alice', 'live');
    domainStore.seed('agent-1', 'ghost', 'ghost.example');
    domainStore.seed('agent-1', 'weather', 'api.weather.gov');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    await getAgentSetupQueue('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    // Ghost rows gone; weather rows preserved.
    const creds = await store.listForAgent('agent-1');
    expect(creds.map(c => c.skillName).sort()).toEqual(['weather']);
    const domains = await domainStore.listForAgent('agent-1');
    expect(domains.map(d => d.skillName).sort()).toEqual(['weather']);
  });

  it('skill is NOT auto-enabled by a row belonging to a different skill with the same envName', async () => {
    // Regression for cross-skill envName sharing at the state-derivation
    // layer. Admin must still click Approve on the new skill even if a prior
    // skill holds a row for the same envName — the approve flow is where
    // value reuse (step 6 in approveSkillSetup) happens.
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
    });

    const store = new InMemorySkillCredStore();
    const domainStore = new InMemorySkillDomainStore();
    // Row belongs to a different skill.
    store.seed('agent-1', 'github', 'LINEAR_TOKEN', 'alice', 'borrowed');
    domainStore.seed('agent-1', 'github', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const queue = await getAgentSetupQueue('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(queue[0].unapprovedDomains).toEqual(['api.linear.app']);
  });

  it('emits missingCredentials for a skill with an unstored envName', async () => {
    seedRepo(bareRepoPath, {
      '.ax/skills/linear/SKILL.md': linearSkill,
    });

    const store = new InMemorySkillCredStore();
    // No LINEAR_TOKEN stored anywhere.
    const domainStore = new InMemorySkillDomainStore();
    domainStore.seed('agent-1', 'linear', 'api.linear.app');

    const cache = createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 8 });
    const queue = await getAgentSetupQueue('agent-1', {
      skillCredStore: store,
      skillDomainStore: domainStore,
      getBareRepoPath: async () => bareRepoPath,
      probeHead: async () => 'sha-abc',
      snapshotCache: cache,
    });

    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials).toEqual([
      { envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user', oauth: undefined },
    ]);
    expect(queue[0].unapprovedDomains).toEqual([]);
  });
});
