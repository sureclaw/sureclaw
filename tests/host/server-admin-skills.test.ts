// tests/host/server-admin-skills.test.ts
//
// Admin skills endpoints: GET/POST/DELETE /admin/api/skills/setup + the
// OAuth start endpoint. All paths derive the pending setup queue live from
// git snapshots via agentSkillsDeps.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { SetupRequest, SkillSnapshotEntry } from '../../src/host/skills/types.js';
import type { GetAgentSkillsDeps } from '../../src/host/skills/get-agent-skills.js';
import type { SkillCredStore } from '../../src/host/skills/skill-cred-store.js';
import { createSnapshotCache } from '../../src/host/skills/snapshot-cache.js';
import type { CredentialProvider } from '../../src/providers/credentials/types.js';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

vi.mock('../../src/host/identity-reader.js', () => ({
  readIdentityForAgent: vi.fn(async () => ({ soul: 'Test soul.', identity: 'Test identity.' })),
  loadIdentityFromGit: vi.fn(() => ({})),
  fetchIdentityFromRemote: vi.fn(() => ({ gitDir: '/tmp/mock', identity: {} })),
  IDENTITY_FILE_MAP: [],
}));

initLogger({ file: false, level: 'silent' });

// ── Git bare-repo seed helpers for agentSkillsDeps fixtures ──

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
  const workTree = fs.mkdtempSync(path.join(tmpdir(), 'ax-admin-skills-work-'));
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

class InMemoryCredentialProvider implements CredentialProvider {
  /** Map<`${scope}::${envName}`, value> */
  private store = new Map<string, string>();

  async get(envName: string, scope?: string): Promise<string | null> {
    return this.store.get(`${scope ?? ''}::${envName}`) ?? null;
  }
  async set(envName: string, value: string, scope?: string): Promise<void> {
    this.store.set(`${scope ?? ''}::${envName}`, value);
  }
  async delete(envName: string, scope?: string): Promise<void> {
    this.store.delete(`${scope ?? ''}::${envName}`);
  }
  async list(scope?: string): Promise<string[]> {
    const out: string[] = [];
    const prefix = `${scope ?? ''}::`;
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
    return out;
  }
}

/**
 * Build an `agentSkillsDeps` wired to a bare repo + in-memory domain/credential
 * stores. Per-agent repos are keyed by agentId → bareRepoPath in
 * `reposByAgentId`. `probeHead` advances whenever a caller mutates the map to
 * force snapshot cache misses across `seedRepo` rebuilds.
 */
function makeAgentSkillsDeps(opts: {
  reposByAgentId: Map<string, string>;
  credentials: CredentialProvider;
  skillCredStore?: import('../../src/host/skills/skill-cred-store.js').SkillCredStore;
  skillDomainStore?: import('../../src/host/skills/skill-domain-store.js').SkillDomainStore;
}): GetAgentSkillsDeps {
  return {
    skillCredStore: opts.skillCredStore ?? {
      async put() { /* no-op */ },
      async get() { return null; },
      async listForAgent() { return []; },
      async listEnvNames() { return new Set(); },
      async deleteForSkill() { /* no-op */ },
    },
    skillDomainStore: opts.skillDomainStore ?? {
      async approve() { /* no-op */ },
      async listForAgent() { return []; },
      async deleteForSkill() { /* no-op */ },
    },
    getBareRepoPath: (agentId) => {
      const p = opts.reposByAgentId.get(agentId);
      if (!p) throw new Error(`no bare repo seeded for agent ${agentId}`);
      return p;
    },
    // The snapshot cache keys on (agentId, headSha). Return the current HEAD
    // so re-seeds after `git push` don't produce stale cache hits across tests
    // that share a single deps object within one `it()`.
    probeHead: async (agentId) => {
      const p = opts.reposByAgentId.get(agentId);
      if (!p) return '';
      try {
        return execFileSync('git', ['-C', p, 'rev-parse', 'HEAD'], {
          encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return '';
      }
    },
    snapshotCache: createSnapshotCache<SkillSnapshotEntry[]>({ maxEntries: 16 }),
  };
}

function makeConfig(): Config {
  return {
    agent_name: 'test-agent',
    profile: 'balanced',
    providers: {
      memory: 'cortex',
      security: 'patterns',
      channels: [],
      web: { extract: 'none', search: 'none' },
      credentials: 'database',
      audit: 'database',
      sandbox: 'docker',
      scheduler: 'none',
    },
    sandbox: { timeout_sec: 120, memory_mb: 512 },
    scheduler: {
      active_hours: { start: '07:00', end: '23:00', timezone: 'UTC' },
      max_token_budget: 4096,
      heartbeat_interval_min: 30,
    },
    history: {
      max_turns: 50,
      thread_context_turns: 5,
      summarize: false,
      summarize_threshold: 40,
      summarize_keep_recent: 10,
      memory_recall: false,
      memory_recall_limit: 5,
      memory_recall_scope: '*',
      embedding_model: 'text-embedding-3-small',
      embedding_dimensions: 1536,
    },
    admin: {
      enabled: true,
      token: 'test-secret-token',
      port: 8080,
    },
  } as Config;
}

interface MockDepsOpts {
  registerOther?: boolean;
  registerArchived?: boolean;
  /** When false, the mock does NOT wire agentSkillsDeps — the admin handler
   *  will return 503 for endpoints that need it. */
  withAgentSkills?: boolean;
  withCredentials?: boolean;
  withStores?: boolean;
  defaultUserId?: string;
  /** Synthesize a live setup queue for each agentId by seeding an in-memory
   *  `agentSkillsDeps` stub. Any card in this map is returned by both
   *  `getAgentSkills` and `getAgentSetupQueue` for the matching agent. */
  setupByAgentId?: Map<string, SetupRequest[]>;
  credentials?: CredentialProvider;
  agentSkillsDeps?: GetAgentSkillsDeps;
}

/**
 * Build a minimal `agentSkillsDeps` whose snapshot entries produce the given
 * setup queue per agentId. Used by approve/dismiss/oauth-start tests that
 * don't need a real git repo — they just need the live queue to contain a
 * specific card.
 */
function stubAgentSkillsDeps(opts: {
  setupByAgentId: Map<string, SetupRequest[]>;
  skillCredStore: import('../../src/host/skills/skill-cred-store.js').SkillCredStore;
  skillDomainStore?: import('../../src/host/skills/skill-domain-store.js').SkillDomainStore;
}): GetAgentSkillsDeps {
  const byAgentId = opts.setupByAgentId;
  return {
    skillCredStore: opts.skillCredStore,
    skillDomainStore: opts.skillDomainStore ?? {
      async approve() { /* no-op */ },
      async listForAgent() { return []; },
      async deleteForSkill() { /* no-op */ },
    },
    async getBareRepoPath() { return '/unused'; },
    async probeHead(agentId) { return `stub@${agentId}`; },
    snapshotCache: {
      get(key) {
        const agentId = key.split('@')[0];
        const cards = byAgentId.get(agentId) ?? [];
        // Synthesize one entry per card with frontmatter that reproduces the
        // pending card (missing creds + unapproved domains).
        return cards.map((c): SkillSnapshotEntry => ({
          name: c.skillName,
          ok: true,
          body: '',
          frontmatter: {
            name: c.skillName,
            description: c.description,
            credentials: c.missingCredentials.map(m => ({
              envName: m.envName,
              authType: m.authType,
              scope: m.scope,
              oauth: m.oauth,
            })),
            domains: c.unapprovedDomains,
            mcpServers: c.mcpServers,
          },
        }));
      },
      put() { /* no-op — get synthesizes every time */ },
      invalidateAgent() { return 0; },
      clear() { /* no-op */ },
      size() { return 0; },
    },
  };
}

/**
 * In-memory `SkillCredStore`. Rows land in an array; list/env-name helpers
 * filter against it. Useful for both the approve + OAuth-start fixtures.
 */
class InMemorySkillCredStore implements SkillCredStore {
  rows: Array<{ agentId: string; skillName: string; envName: string; userId: string; value: string }> = [];
  async put(input: { agentId: string; skillName: string; envName: string; userId: string; value: string }): Promise<void> {
    const idx = this.rows.findIndex(r =>
      r.agentId === input.agentId &&
      r.skillName === input.skillName &&
      r.envName === input.envName &&
      r.userId === input.userId,
    );
    if (idx >= 0) this.rows[idx] = { ...input };
    else this.rows.push({ ...input });
  }
  async get(input: { agentId: string; skillName: string; envName: string; userId: string }): Promise<{ value: string } | null> {
    const row = this.rows.find(r =>
      r.agentId === input.agentId &&
      r.skillName === input.skillName &&
      r.envName === input.envName &&
      r.userId === input.userId,
    );
    return row ? { value: row.value } : null;
  }
  async listForAgent(agentId: string) {
    return this.rows.filter(r => r.agentId === agentId).map(r => ({ ...r }));
  }
  async listEnvNames(agentId: string): Promise<Set<string>> {
    return new Set(this.rows.filter(r => r.agentId === agentId).map(r => r.envName));
  }
  async deleteForSkill(agentId: string, skillName: string): Promise<void> {
    this.rows = this.rows.filter(r => !(r.agentId === agentId && r.skillName === skillName));
  }
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<AdminDeps & {
  skillCredStoreMem: InMemorySkillCredStore;
  setupByAgentId: Map<string, SetupRequest[]>;
  syncToolModulesMock: ReturnType<typeof vi.fn>;
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-skills-test-'));
  const config = makeConfig();
  const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  await registry.register({
    id: 'main', name: 'Main Agent', description: 'Primary agent', status: 'active',
    parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
  });
  if (opts.registerOther) {
    await registry.register({
      id: 'other', name: 'Other Agent', description: 'Another agent', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
  }
  if (opts.registerArchived) {
    await registry.register({
      id: 'archived', name: 'Archived Agent', description: 'Archived agent', status: 'active',
      parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
    });
    await registry.update('archived', { status: 'archived' });
  }

  const providers: Record<string, unknown> = {
    audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
  };

  if (opts.withCredentials !== false) {
    if (opts.credentials) {
      providers.credentials = opts.credentials;
    } else {
      providers.credentials = {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue([]),
      };
    }
  }

  // Stub syncToolModules. Required in AdminDeps — every test gets a mock
  // that returns a fixed success result so approvals on skills without MCP
  // servers don't invoke it (the handler gates on `mcpServers.length > 0`),
  // and approvals on skills WITH MCP servers record the input for assertions.
  const syncToolModulesMock = vi.fn().mockResolvedValue({
    commit: 'abc123',
    changed: true,
    moduleCount: 2,
    toolCount: 3,
  });

  const deps: AdminDeps = {
    config,
    providers: providers as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
    syncToolModules: syncToolModulesMock,
  };

  // Shared in-memory stores — reused across seeded queue + approve writes.
  const skillCredStoreMem = new InMemorySkillCredStore();
  // Spy-wrapped domain store so tests can assert on approve() calls. Backed
  // by an in-memory row array so the live state derivation sees the rows the
  // approve handler wrote.
  const domainApprovals: Array<{ agentId: string; skillName: string; domain: string }> = [];
  const skillDomainStoreMem = {
    approve: vi.fn(async (input: { agentId: string; skillName: string; domain: string }) => {
      const exists = domainApprovals.some(r =>
        r.agentId === input.agentId && r.skillName === input.skillName && r.domain === input.domain);
      if (!exists) domainApprovals.push({ ...input });
    }),
    listForAgent: vi.fn(async (agentId: string) =>
      domainApprovals
        .filter(r => r.agentId === agentId)
        .map(r => ({ skillName: r.skillName, domain: r.domain })),
    ),
    deleteForSkill: vi.fn(async (agentId: string, skillName: string) => {
      for (let i = domainApprovals.length - 1; i >= 0; i--) {
        if (domainApprovals[i].agentId === agentId && domainApprovals[i].skillName === skillName) {
          domainApprovals.splice(i, 1);
        }
      }
    }),
  };
  const setupByAgentId = opts.setupByAgentId ?? new Map<string, SetupRequest[]>();

  if (opts.withStores !== false) {
    deps.skillCredStore = skillCredStoreMem;
    deps.skillDomainStore = skillDomainStoreMem;
  }

  if (opts.defaultUserId !== undefined) {
    deps.defaultUserId = opts.defaultUserId;
  }

  if (opts.agentSkillsDeps) {
    deps.agentSkillsDeps = opts.agentSkillsDeps;
  } else if (opts.withAgentSkills !== false) {
    deps.agentSkillsDeps = stubAgentSkillsDeps({
      setupByAgentId,
      skillCredStore: skillCredStoreMem,
      skillDomainStore: skillDomainStoreMem,
    });
  }

  return Object.assign(deps, { skillCredStoreMem, skillDomainStoreMem, setupByAgentId, syncToolModulesMock });
}

function startTestServer(
  handler: ReturnType<typeof createAdminHandler>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/admin')) {
        // Mirror production outer try/catch from server-request-handlers.ts:
        // unhandled throws from an admin route surface as 500.
        try {
          await handler(req, res, url.split('?')[0]);
        } catch (_err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Admin request failed' } }));
          }
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()!;
      resolve({ server, port: (addr as { port: number }).port });
    });
  });
}

async function fetchAdmin(
  port: number,
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const mainCard: SetupRequest = {
  skillName: 'linear',
  description: 'Linear stuff',
  missingCredentials: [
    { envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' },
  ],
  unapprovedDomains: ['api.linear.app'],
  mcpServers: [{ name: 'linear-mcp', url: 'https://mcp.linear.app/sse' }],
};

// SKILL.md fixtures used by the GET /admin/api/skills/setup tests. Each
// produces a setup card with a specific shape matching the legacy SetupRequest
// fixtures those tests used to rely on.

const linearSkillMd = `---
name: linear
description: Linear stuff
credentials:
  - envName: LINEAR_TOKEN
    authType: api_key
    scope: user
domains:
  - api.linear.app
mcpServers:
  - name: linear-mcp
    url: https://mcp.linear.app/sse
---

# Linear
`;

const alphaSkillMd = `---
name: alpha
description: First skill
credentials:
  - envName: A_TOKEN
    authType: api_key
    scope: agent
domains:
  - a.example.com
  - b.example.com
mcpServers:
  - name: alpha-mcp
    url: https://a.example.com/mcp
---

# Alpha
`;

const betaSkillMd = `---
name: beta
description: Second skill
credentials:
  - envName: B_OAUTH
    authType: oauth
    scope: user
    oauth:
      provider: github
      clientId: abc123
      authorizationUrl: https://github.com/login/oauth/authorize
      tokenUrl: https://github.com/login/oauth/access_token
      scopes:
        - repo
        - read:user
---

# Beta
`;

const ghostSkillMd = `---
name: ghost
description: Archived agent's skill
credentials:
  - envName: LINEAR_TOKEN
    authType: api_key
    scope: user
domains:
  - api.linear.app
---

# Ghost
`;

describe('GET /admin/api/skills/setup', () => {
  let server: Server;
  let port: number;
  const repos: string[] = [];

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
    while (repos.length) {
      const p = repos.pop()!;
      try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  /**
   * Build a bare repo for one agent, optionally seeded with SKILL.md files.
   * Records the path in `repos` so `afterEach` cleans it up. Always seeds at
   * least a README.md so `refs/heads/main` exists — otherwise ls-tree fails
   * with "unknown revision" and the endpoint surfaces 500.
   */
  function newAgentRepo(agentId: string, files: Record<string, string> = {}): string {
    const bareRepoPath = path.join(
      tmpdir(),
      `ax-admin-skills-${agentId}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
    );
    initBareRepo(bareRepoPath);
    seedRepo(bareRepoPath, { 'README.md': `# ${agentId}\n`, ...files });
    repos.push(bareRepoPath);
    return bareRepoPath;
  }

  it('returns cards grouped by agent (only agents with non-empty queues)', async () => {
    // `main` has linear (pending — no LINEAR_TOKEN stored, api.linear.app not approved).
    // `other` has an empty workspace → empty queue → filtered out.
    const reposByAgentId = new Map<string, string>();
    reposByAgentId.set('main', newAgentRepo('main', { '.ax/skills/linear/SKILL.md': linearSkillMd }));
    reposByAgentId.set('other', newAgentRepo('other'));

    const creds = new InMemoryCredentialProvider();
    const agentSkillsDeps = makeAgentSkillsDeps({
      reposByAgentId,
      credentials: creds,
    });

    const deps = await mockDeps({
      registerOther: true,
      agentSkillsDeps,
      credentials: creds,
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ agentId: string; agentName: string; cards: unknown[] }> };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].agentId).toBe('main');
    expect(body.agents[0].agentName).toBe('Main Agent');
    // The setup endpoint decorates each missingCredential with a
    // `hasExistingValue` hint so the UI can show "reuse existing" and relax
    // its Approve-disable rule. The credentials store is empty here, so every
    // hint is `false` — the rest of the card matches the live-computed
    // SetupRequest for linear.
    expect(body.agents[0].cards).toEqual([
      {
        ...mainCard,
        missingCredentials: mainCard.missingCredentials.map(mc => ({
          ...mc,
          // `oauth` is always present (possibly undefined) on the live-computed
          // shape — see reconciler.computeSetupQueue.
          oauth: undefined,
          hasExistingValue: false,
        })),
      },
    ]);
  });

  it('returns empty agents array when no agent has queue entries', async () => {
    const reposByAgentId = new Map<string, string>();
    reposByAgentId.set('main', newAgentRepo('main'));
    reposByAgentId.set('other', newAgentRepo('other'));

    const agentSkillsDeps = makeAgentSkillsDeps({
      reposByAgentId,
      credentials: new InMemoryCredentialProvider(),
    });

    const deps = await mockDeps({
      registerOther: true,
      agentSkillsDeps,
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it('returns 503 with "Skills not configured" when agentSkillsDeps is missing', async () => {
    const deps = await mockDeps({ withAgentSkills: false });
    expect(deps.agentSkillsDeps).toBeUndefined();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(503);
    // sendError() wraps the message in { error: { message, type, code } } — see src/host/server-http.ts.
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });

  it('excludes archived agents from the result', async () => {
    // Archived agent has a pending skill in its repo — it must still be
    // excluded because agentRegistry.list('active') skips archived agents.
    const reposByAgentId = new Map<string, string>();
    reposByAgentId.set('main', newAgentRepo('main'));
    reposByAgentId.set('archived', newAgentRepo('archived', { '.ax/skills/ghost/SKILL.md': ghostSkillMd }));

    const agentSkillsDeps = makeAgentSkillsDeps({
      reposByAgentId,
      credentials: new InMemoryCredentialProvider(),
    });

    const deps = await mockDeps({
      registerArchived: true,
      agentSkillsDeps,
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ agentId: string }> };
    expect(body.agents.map(a => a.agentId)).not.toContain('archived');
    expect(body.agents).toEqual([]);
  });

  it('preserves card order and all fields from live-computed setup queue', async () => {
    // alpha + beta in the same repo, in that order — the snapshot walker emits
    // them in alphabetical order (see buildSnapshotFromBareRepo), so alpha
    // comes before beta in the response.
    const reposByAgentId = new Map<string, string>();
    reposByAgentId.set('main', newAgentRepo('main', {
      '.ax/skills/alpha/SKILL.md': alphaSkillMd,
      '.ax/skills/beta/SKILL.md': betaSkillMd,
    }));

    const agentSkillsDeps = makeAgentSkillsDeps({
      reposByAgentId,
      credentials: new InMemoryCredentialProvider(),
    });

    const deps = await mockDeps({ agentSkillsDeps });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ cards: SetupRequest[] }> };
    expect(body.agents).toHaveLength(1);

    const cards = body.agents[0].cards;
    expect(cards).toHaveLength(2);

    // alpha: agent-scoped api_key missing + two unapproved domains, with a
    // hasExistingValue hint on the missing credential.
    expect(cards[0]).toEqual({
      skillName: 'alpha',
      description: 'First skill',
      missingCredentials: [{
        envName: 'A_TOKEN',
        authType: 'api_key',
        scope: 'agent',
        oauth: undefined,
        hasExistingValue: false,
      }],
      unapprovedDomains: ['a.example.com', 'b.example.com'],
      mcpServers: [{ name: 'alpha-mcp', url: 'https://a.example.com/mcp' }],
    });

    // beta: user-scoped oauth missing, no domains, no mcp servers.
    expect(cards[1]).toEqual({
      skillName: 'beta',
      description: 'Second skill',
      missingCredentials: [{
        envName: 'B_OAUTH',
        authType: 'oauth',
        scope: 'user',
        oauth: {
          provider: 'github',
          clientId: 'abc123',
          authorizationUrl: 'https://github.com/login/oauth/authorize',
          tokenUrl: 'https://github.com/login/oauth/access_token',
          scopes: ['repo', 'read:user'],
        },
        hasExistingValue: false,
      }],
      unapprovedDomains: [],
      mcpServers: [],
    });
  });

  it('sets hasExistingValue=true when a stored credential matches an envName on a pending card', async () => {
    // Linear declares LINEAR_TOKEN at `scope: user`; only an agent-scope row
    // exists in skill_credentials. The reconciler sees LINEAR_TOKEN@user as
    // missing → card emitted. The endpoint probes skill_credentials for any
    // row with this envName (across skills / users) and flips the hint on.
    const reposByAgentId = new Map<string, string>();
    reposByAgentId.set('main', newAgentRepo('main', { '.ax/skills/linear/SKILL.md': linearSkillMd }));

    const creds = new InMemoryCredentialProvider();
    const skillCredStore = {
      _rows: [] as Array<{ agentId: string; skillName: string; envName: string; userId: string; value: string }>,
      async put(input: { agentId: string; skillName: string; envName: string; userId: string; value: string }) {
        this._rows.push(input);
      },
      async get() { return null; },
      async listForAgent(agentId: string) {
        return this._rows.filter(r => r.agentId === agentId);
      },
      async listEnvNames(agentId: string) {
        return new Set(this._rows.filter(r => r.agentId === agentId).map(r => r.envName));
      },
    };
    await skillCredStore.put({
      agentId: 'main', skillName: 'linear', envName: 'LINEAR_TOKEN', userId: '', value: 'existing-value',
    });

    const agentSkillsDeps = makeAgentSkillsDeps({
      reposByAgentId,
      credentials: creds,
      skillCredStore,
    });

    const deps = await mockDeps({
      agentSkillsDeps,
      credentials: creds,
    });
    deps.skillCredStore = skillCredStore;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ cards: SetupRequest[] }> };
    expect(body.agents).toHaveLength(1);
    const card = body.agents[0].cards[0] as SetupRequest & {
      missingCredentials: Array<{ envName: string; hasExistingValue?: boolean }>;
    };
    expect(card.skillName).toBe('linear');
    expect(card.missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(card.missingCredentials[0].hasExistingValue).toBe(true);
  });
});

// ── POST /admin/api/skills/setup/approve ──────────────────────────────────

const weatherAgentScoped: SetupRequest = {
  skillName: 'weather',
  description: 'Weather lookups',
  missingCredentials: [
    { envName: 'W_KEY', authType: 'api_key', scope: 'agent' },
  ],
  unapprovedDomains: ['api.weather.com'],
  mcpServers: [],
};

const weatherUserScoped: SetupRequest = {
  skillName: 'weather',
  description: 'Weather lookups',
  missingCredentials: [
    { envName: 'W_KEY', authType: 'api_key', scope: 'user' },
  ],
  unapprovedDomains: ['api.weather.com'],
  mcpServers: [],
};

const weatherOauth: SetupRequest = {
  skillName: 'weather',
  description: 'Weather lookups',
  missingCredentials: [
    {
      envName: 'W_OAUTH',
      authType: 'oauth',
      scope: 'user',
      oauth: {
        provider: 'weather-corp',
        clientId: 'cid',
        authorizationUrl: 'https://auth.weather.com/authorize',
        tokenUrl: 'https://auth.weather.com/token',
        scopes: ['read'],
      },
    },
  ],
  unapprovedDomains: [],
  mcpServers: [],
};

describe('POST /admin/api/skills/setup/approve', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  function seed(deps: Awaited<ReturnType<typeof mockDeps>>, cards: SetupRequest[], agentId = 'main') {
    deps.setupByAgentId.set(agentId, cards);
  }

  it('happy path: agent-scoped credential stored with user_id = "", domain approved, audit called', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const domainApprove = deps.skillDomainStoreMem.approve;
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 'secret-123' }],
        approveDomains: ['api.weather.com'],
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; state: unknown };
    expect(body.ok).toBe(true);

    expect(deps.skillCredStoreMem.rows).toEqual([{
      agentId: 'main',
      skillName: 'weather',
      envName: 'W_KEY',
      userId: '',
      value: 'secret-123',
    }]);

    expect(domainApprove).toHaveBeenCalledWith({
      agentId: 'main', skillName: 'weather', domain: 'api.weather.com',
    });

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('skill_approved');
    expect(auditCall.args).toMatchObject({
      agentId: 'main',
      skillName: 'weather',
      domains: ['api.weather.com'],
      envNames: ['W_KEY'],
    });
    // Credential value must NEVER appear in audit args.
    expect(JSON.stringify(auditCall.args)).not.toContain('secret-123');
  });

  it('happy path: user-scoped credential with explicit userId writes user_id = <userId>', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherUserScoped]);
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: [],
        userId: 'alice',
      },
    });

    expect(res.status).toBe(200);
    expect(deps.skillCredStoreMem.rows).toEqual([{
      agentId: 'main',
      skillName: 'weather',
      envName: 'W_KEY',
      userId: 'alice',
      value: 's',
    }]);
  });

  it('user scope without userId falls back to defaultUserId', async () => {
    const deps = await mockDeps({ defaultUserId: 'bob' });
    seed(deps, [weatherUserScoped]);
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: [],
      },
    });

    expect(res.status).toBe(200);
    expect(deps.skillCredStoreMem.rows).toEqual([{
      agentId: 'main',
      skillName: 'weather',
      envName: 'W_KEY',
      userId: 'bob',
      value: 's',
    }]);
  });

  it("user scope without userId + without defaultUserId falls back to 'admin'", async () => {
    const deps = await mockDeps();
    seed(deps, [weatherUserScoped]);
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: [],
      },
    });

    expect(res.status).toBe(200);
    expect(deps.skillCredStoreMem.rows).toEqual([{
      agentId: 'main',
      skillName: 'weather',
      envName: 'W_KEY',
      userId: 'admin',
      value: 's',
    }]);
  });

  it('rejects unexpected credential envName with 400; nothing applied', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const domainApprove = deps.skillDomainStoreMem.approve;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'EVIL_KEY', value: 's' }],
        approveDomains: ['api.weather.com'],
      },
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string; details: string };
    expect(body.error).toBe('Request does not match pending setup');
    expect(body.details).toContain('EVIL_KEY');
    expect(deps.skillCredStoreMem.rows).toEqual([]);
    expect(domainApprove).not.toHaveBeenCalled();
  });

  it('rejects unexpected domain with 400; nothing applied', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const domainApprove = deps.skillDomainStoreMem.approve;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: ['evil.com'],
      },
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string; details: string };
    expect(body.error).toBe('Request does not match pending setup');
    expect(body.details).toContain('evil.com');
    expect(deps.skillCredStoreMem.rows).toEqual([]);
    expect(domainApprove).not.toHaveBeenCalled();
  });

  it('rejects OAuth credential with 400 and clear message', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherOauth]);
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_OAUTH', value: 's' }],
        approveDomains: [],
      },
    });

    expect(res.status).toBe(400);
    const body = res.body as { error: string; details: string };
    expect(body.error).toContain('OAuth');
    expect(body.details).toBe('W_OAUTH');
    expect(deps.skillCredStoreMem.rows).toEqual([]);
  });

  it('returns 404 when skill is not in the setup queue', async () => {
    const deps = await mockDeps();
    // no seed — queue is empty for `main`.
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [],
        approveDomains: [],
      },
    });

    expect(res.status).toBe(404);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('No pending setup for this skill');
  });

  it('returns 503 when agentSkillsDeps is missing', async () => {
    const deps = await mockDeps({ withAgentSkills: false });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [],
        approveDomains: [],
      },
    });

    expect(res.status).toBe(503);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });

  it('returns 400 on invalid body (Zod validation failure)', async () => {
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {}, // missing agentId + skillName
    });

    expect(res.status).toBe(400);
  });

  it('validation is atomic: mix of valid credential + invalid domain → nothing applied', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const domainApprove = deps.skillDomainStoreMem.approve;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 'valid-secret' }],
        approveDomains: ['evil.com'], // invalid — not in card
      },
    });

    expect(res.status).toBe(400);
    // Load-bearing: even the valid credential must NOT be persisted.
    expect(deps.skillCredStoreMem.rows).toEqual([]);
    expect(domainApprove).not.toHaveBeenCalled();
  });

  it('approve returns the fresh skill state read live after writes', async () => {
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: ['api.weather.com'],
      },
    });

    expect(res.status).toBe(200);
    const body = res.body as { ok: boolean; state: { name: string; kind: string } };
    expect(body.ok).toBe(true);
    // After cred is stored + domain approved, live derivation reports enabled.
    expect(body.state.name).toBe('weather');
    expect(body.state.kind).toBe('enabled');
  });

  it('returns 500 when audit.log throws — unexpected server errors are not masked as 400', async () => {
    // Regression: the approve route previously wrapped the entire flow in one try/catch
    // that reported every throw as 400 "Invalid request". That masked real server-side
    // failures (audit.log rejection) as client bugs. The catch is now narrowed to
    // JSON.parse only, so unexpected throws fall through to the outer HTTP handler,
    // which returns 500.
    const deps = await mockDeps();
    seed(deps, [weatherAgentScoped]);
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;
    auditLog.mockRejectedValueOnce(new Error('database down'));

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'weather',
        credentials: [{ envName: 'W_KEY', value: 's' }],
        approveDomains: ['api.weather.com'],
      },
    });

    expect(res.status).toBe(500);
    // Must NOT be the old 400 "Invalid request: ..." response.
    const body = res.body as { error?: { message?: string } } | null;
    expect(body?.error?.message).not.toMatch(/^Invalid request:/);
  });

  describe('tool-module sync on approval', () => {
    const weatherWithMcp: SetupRequest = {
      skillName: 'weather',
      description: 'Weather lookups',
      missingCredentials: [
        { envName: 'W_KEY', authType: 'api_key', scope: 'agent' },
      ],
      unapprovedDomains: ['api.weather.com'],
      mcpServers: [{ name: 'weather-mcp', url: 'https://weather.example.com/mcp' }],
    };

    it('calls syncToolModules with (agentId, skillName, mcpServers, userId) when approval enables a skill with MCP servers', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherWithMcp]);

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);
      expect(deps.syncToolModulesMock).toHaveBeenCalledTimes(1);
      expect(deps.syncToolModulesMock).toHaveBeenCalledWith({
        agentId: 'main',
        skillName: 'weather',
        mcpServers: [{ name: 'weather-mcp', url: 'https://weather.example.com/mcp' }],
        userId: 'admin',
      });
    });

    it('does NOT call syncToolModules when the skill declares no MCP servers', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherAgentScoped]); // mcpServers: []

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);
      expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
    });

    it('does NOT call syncToolModules when the approved skill is still pending', async () => {
      // Two missing credentials — we only supply one. State stays `pending`,
      // so the tool-sync path must stay silent (it'll fire on the later
      // approval that finishes the setup, or via explicit admin refresh).
      const partialPending: SetupRequest = {
        skillName: 'weather',
        description: 'Weather lookups',
        missingCredentials: [
          { envName: 'W_KEY', authType: 'api_key', scope: 'agent' },
          { envName: 'W_OTHER', authType: 'api_key', scope: 'agent' },
        ],
        unapprovedDomains: [],
        mcpServers: [{ name: 'weather-mcp', url: 'https://weather.example.com/mcp' }],
      };
      const deps = await mockDeps();
      seed(deps, [partialPending]);

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: [],
        },
      });

      // The approve flow validates against the card shape (every missing
      // cred must resolve); W_OTHER is missing from the body AND from any
      // stored row, so the helper 400s. That's fine — the point here is
      // that the sync closure is NOT invoked on a card that can't reach
      // `enabled`.
      expect(res.status).toBe(400);
      expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
    });

    it('audit log includes toolSync.moduleCount + toolSync.toolCount on success', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherWithMcp]);
      deps.syncToolModulesMock.mockResolvedValueOnce({
        commit: 'deadbeef',
        changed: true,
        moduleCount: 4,
        toolCount: 7,
      });
      const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);
      expect(auditLog).toHaveBeenCalledTimes(1);
      const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
      expect(auditCall.action).toBe('skill_approved');
      expect(auditCall.args).toMatchObject({
        toolSync: { moduleCount: 4, toolCount: 7, commit: 'deadbeef' },
      });
      expect(auditCall.args).not.toHaveProperty('toolSyncError');
    });

    it('syncToolModules throwing does NOT fail the approval; audit logs toolSyncError', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherWithMcp]);
      deps.syncToolModulesMock.mockRejectedValueOnce(new Error('mcp server unreachable'));
      const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      // Approval succeeds — tool generation is best-effort at approve time.
      expect(res.status).toBe(200);
      const body = res.body as { ok: boolean; state: { name: string; kind: string } };
      expect(body.ok).toBe(true);
      expect(body.state.kind).toBe('enabled');

      expect(auditLog).toHaveBeenCalledTimes(1);
      const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
      expect(auditCall.args).toMatchObject({
        toolSyncError: 'mcp server unreachable',
      });
      expect(auditCall.args).not.toHaveProperty('toolSync');
    });

    it('threads the authenticated user id into syncToolModules input when BetterAuth is wired', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherWithMcp]);
      deps.resolveAuthenticatedUser = async () => ({ id: 'auth-uuid-123', email: 'a@b.com' });

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);
      expect(deps.syncToolModulesMock).toHaveBeenCalledTimes(1);
      const args = deps.syncToolModulesMock.mock.calls[0][0] as { userId: string };
      expect(args.userId).toBe('auth-uuid-123');
    });
  });

  describe('writes to skill_credentials + skill_domain_approvals', () => {
    it('agent-scoped credential and domain approval land in the tuple-keyed stores', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherAgentScoped]);
      const domainApprove = deps.skillDomainStoreMem.approve;

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 'the-secret' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);

      // Tuple-keyed writes. Agent-scope credential entry writes user_id = ''
      // (the sentinel).
      expect(deps.skillCredStoreMem.rows).toEqual([{
        agentId: 'main',
        skillName: 'weather',
        envName: 'W_KEY',
        userId: '',
        value: 'the-secret',
      }]);
      expect(domainApprove).toHaveBeenCalledTimes(1);
      expect(domainApprove).toHaveBeenCalledWith({
        agentId: 'main',
        skillName: 'weather',
        domain: 'api.weather.com',
      });
    });

    it('user-scoped credential writes the caller userId into skill_credentials.user_id', async () => {
      const deps = await mockDeps();
      seed(deps, [weatherUserScoped]);

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
          userId: 'alice',
        },
      });

      expect(res.status).toBe(200);
      expect(deps.skillCredStoreMem.rows).toEqual([{
        agentId: 'main',
        skillName: 'weather',
        envName: 'W_KEY',
        userId: 'alice',
        value: 's',
      }]);
    });

    it('returns 503 when the tuple-keyed stores are missing', async () => {
      const deps = await mockDeps({ withStores: false });
      seed(deps, [weatherAgentScoped]);

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 's' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(503);
      expect(deps.skillCredStoreMem.rows).toEqual([]);
    });

    it('end-to-end with real SQLite Kysely: both tables contain the approved row', async () => {
      const Database = (await import('better-sqlite3')).default;
      const { Kysely, SqliteDialect } = await import('kysely');
      const { runMigrations } = await import('../../src/utils/migrator.js');
      const { skillsMigrations } = await import('../../src/migrations/skills.js');
      const { createSkillCredStore } = await import('../../src/host/skills/skill-cred-store.js');
      const { createSkillDomainStore } = await import('../../src/host/skills/skill-domain-store.js');

      const sqliteDb = new Database(':memory:');
      const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
      const mig = await runMigrations(db, skillsMigrations, 'skills_migration');
      if (mig.error) throw mig.error;

      const deps = await mockDeps();
      seed(deps, [weatherAgentScoped]);
      deps.skillCredStore = createSkillCredStore(db, 'sqlite');
      deps.skillDomainStore = createSkillDomainStore(db);
      // The approve handler now uses a single skillCredStore for the reuse
      // probe + the tuple-keyed write, so swap it into agentSkillsDeps too.
      deps.agentSkillsDeps = stubAgentSkillsDeps({
        setupByAgentId: deps.setupByAgentId,
        skillCredStore: deps.skillCredStore,
        skillDomainStore: deps.skillDomainStore,
      });

      const handler = createAdminHandler(deps);
      ({ server, port } = await startTestServer(handler));

      const res = await fetchAdmin(port, '/admin/api/skills/setup/approve', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          agentId: 'main',
          skillName: 'weather',
          credentials: [{ envName: 'W_KEY', value: 'real-secret' }],
          approveDomains: ['api.weather.com'],
        },
      });

      expect(res.status).toBe(200);

      const credRow = await db
        .selectFrom('skill_credentials')
        .selectAll()
        .where('agent_id', '=', 'main')
        .where('skill_name', '=', 'weather')
        .where('env_name', '=', 'W_KEY')
        .where('user_id', '=', '')
        .executeTakeFirstOrThrow();
      expect(credRow.value).toBe('real-secret');

      const domainRow = await db
        .selectFrom('skill_domain_approvals')
        .selectAll()
        .where('agent_id', '=', 'main')
        .where('skill_name', '=', 'weather')
        .where('domain', '=', 'api.weather.com')
        .executeTakeFirstOrThrow();
      expect(domainRow.domain).toBe('api.weather.com');

      await db.destroy();
    });
  });
});

// ── DELETE /admin/api/skills/setup/:agentId/:skillName ─────────────────────

const linearCard: SetupRequest = {
  skillName: 'linear',
  description: 'Linear stuff',
  missingCredentials: [
    { envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' },
  ],
  unapprovedDomains: ['api.linear.app'],
  mcpServers: [],
};

const weatherCard: SetupRequest = {
  skillName: 'weather',
  description: 'Weather lookups',
  missingCredentials: [
    { envName: 'W_KEY', authType: 'api_key', scope: 'agent' },
  ],
  unapprovedDomains: ['api.weather.com'],
  mcpServers: [],
};

describe('DELETE /admin/api/skills/setup/:agentId/:skillName', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('happy path: emits audit when the card is in the live queue', async () => {
    const deps = await mockDeps();
    deps.setupByAgentId.set('main', [linearCard, weatherCard]);
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('skill_dismissed');
    expect(auditCall.args).toEqual({ agentId: 'main', skillName: 'linear' });
  });

  it('idempotent: skill not in queue → 200 { removed: false }, no audit', async () => {
    const deps = await mockDeps();
    deps.setupByAgentId.set('main', [weatherCard]);
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: false });
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('decodes URL-encoded skill names (segments with hyphens)', async () => {
    const fooBarCard: SetupRequest = { ...linearCard, skillName: 'foo-bar' };
    const deps = await mockDeps();
    deps.setupByAgentId.set('main', [fooBarCard]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/foo-bar', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });
  });

  it('returns 503 "Skills not configured" when agentSkillsDeps is missing', async () => {
    const deps = await mockDeps({ withAgentSkills: false });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(503);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });
});

