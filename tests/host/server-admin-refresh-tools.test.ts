// tests/host/server-admin-refresh-tools.test.ts
//
// POST /admin/api/agents/:agentId/skills/:skillName/refresh-tools.
//
// The refresh-tools endpoint is the explicit admin hook for regenerating
// a skill's committed `.ax/tools/<skill>/` tree. Unlike the approval path,
// which swallows sync errors into the audit log so the write side-effects
// stick, refresh surfaces the error as 500 — the admin clicked this button
// to see the result, and silent failure is worse than loud.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { SkillSnapshotEntry } from '../../src/host/skills/types.js';
import type { GetAgentSkillsDeps } from '../../src/host/skills/get-agent-skills.js';
import type { SkillCredStore } from '../../src/host/skills/skill-cred-store.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** In-memory SkillCredStore — not exercised by refresh, but required by the
 *  shape of AdminDeps. Mirrors the shape in server-admin-skills.test.ts. */
class InMemorySkillCredStore implements SkillCredStore {
  rows: Array<{ agentId: string; skillName: string; envName: string; userId: string; value: string }> = [];
  async put(input: { agentId: string; skillName: string; envName: string; userId: string; value: string }): Promise<void> {
    this.rows.push({ ...input });
  }
  async get() { return null; }
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

/**
 * Build an `agentSkillsDeps` whose snapshot entries are synthesized from a
 * supplied list per agentId. Mirrors the stub shape in server-admin-skills.test.ts
 * so tests can assert on getAgentSkills + loadSnapshot results without seeding
 * a real git repo.
 */
function stubAgentSkillsDeps(opts: {
  snapshotByAgentId: Map<string, SkillSnapshotEntry[]>;
  skillCredStore: SkillCredStore;
}): GetAgentSkillsDeps {
  const byAgentId = opts.snapshotByAgentId;
  return {
    skillCredStore: opts.skillCredStore,
    skillDomainStore: {
      async approve() { /* no-op */ },
      async listForAgent() { return []; },
      async deleteForSkill() { /* no-op */ },
    },
    async getBareRepoPath() { return '/unused'; },
    async probeHead(agentId) { return `stub@${agentId}`; },
    snapshotCache: {
      get(key) {
        const agentId = key.split('@')[0];
        return byAgentId.get(agentId) ?? [];
      },
      put() { /* no-op */ },
      invalidateAgent() { return 0; },
      clear() { /* no-op */ },
      size() { return 0; },
    },
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
  withAgentSkills?: boolean;
  snapshotByAgentId?: Map<string, SkillSnapshotEntry[]>;
  defaultUserId?: string;
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<AdminDeps & {
  skillCredStoreMem: InMemorySkillCredStore;
  snapshotByAgentId: Map<string, SkillSnapshotEntry[]>;
  syncToolModulesMock: ReturnType<typeof vi.fn>;
}> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-refresh-tools-test-'));
  const config = makeConfig();
  const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  await registry.register({
    id: 'main', name: 'Main Agent', description: 'Primary agent', status: 'active',
    parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
  });

  const providers: Record<string, unknown> = {
    audit: { log: vi.fn().mockResolvedValue(undefined), query: vi.fn().mockResolvedValue([]) },
  };

  const syncToolModulesMock = vi.fn().mockResolvedValue({
    commit: 'abc123',
    changed: true,
    moduleCount: 2,
    toolCount: 3,
  });

  const skillCredStoreMem = new InMemorySkillCredStore();
  const snapshotByAgentId = opts.snapshotByAgentId ?? new Map<string, SkillSnapshotEntry[]>();

  const deps: AdminDeps = {
    config,
    providers: providers as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
    syncToolModules: syncToolModulesMock,
    skillCredStore: skillCredStoreMem,
    skillDomainStore: {
      async approve() { /* no-op */ },
      async listForAgent() { return []; },
      async deleteForSkill() { /* no-op */ },
    },
  };

  if (opts.defaultUserId !== undefined) {
    deps.defaultUserId = opts.defaultUserId;
  }

  if (opts.withAgentSkills !== false) {
    deps.agentSkillsDeps = stubAgentSkillsDeps({
      snapshotByAgentId,
      skillCredStore: skillCredStoreMem,
    });
  }

  return Object.assign(deps, { skillCredStoreMem, snapshotByAgentId, syncToolModulesMock });
}

function startTestServer(
  handler: ReturnType<typeof createAdminHandler>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/admin')) {
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

// ── Snapshot fixtures ────────────────────────────────────────────────────────

const enabledLinearEntry: SkillSnapshotEntry = {
  name: 'linear',
  ok: true,
  body: '',
  frontmatter: {
    name: 'linear',
    description: 'Linear stuff',
    credentials: [],
    domains: [],
    mcpServers: [{ name: 'linear-mcp', url: 'https://mcp.linear.app/sse' }],
  },
};

const pendingSkillEntry: SkillSnapshotEntry = {
  name: 'weather',
  ok: true,
  body: '',
  frontmatter: {
    name: 'weather',
    description: 'Weather lookups',
    credentials: [
      { envName: 'W_KEY', authType: 'api_key', scope: 'agent' },
    ],
    domains: ['api.weather.com'],
    mcpServers: [{ name: 'weather-mcp', url: 'https://weather.example.com/mcp' }],
  },
};

const enabledNoMcpEntry: SkillSnapshotEntry = {
  name: 'noop',
  ok: true,
  body: '',
  frontmatter: {
    name: 'noop',
    description: 'Has no MCP servers',
    credentials: [],
    domains: [],
    mcpServers: [],
  },
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe('POST /admin/api/agents/:agentId/skills/:skillName/refresh-tools', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('happy path: calls syncToolModules with reason=refresh, returns 200 with commit/moduleCount/toolCount', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      commit: 'abc123',
      moduleCount: 2,
      toolCount: 3,
    });

    expect(deps.syncToolModulesMock).toHaveBeenCalledTimes(1);
    expect(deps.syncToolModulesMock).toHaveBeenCalledWith({
      agentId: 'main',
      skillName: 'linear',
      mcpServers: [{ name: 'linear-mcp', url: 'https://mcp.linear.app/sse' }],
      userId: 'admin',
      reason: 'refresh',
    });
  });

  it('threads the authenticated user id into syncToolModules input when BetterAuth is wired', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);
    deps.resolveAuthenticatedUser = async () => ({ id: 'auth-uuid-123', email: 'a@b.com' });

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const args = deps.syncToolModulesMock.mock.calls[0][0] as { userId: string };
    expect(args.userId).toBe('auth-uuid-123');
  });

  it('falls back to defaultUserId when no authenticated user and defaultUserId set', async () => {
    const deps = await mockDeps({ defaultUserId: 'bob' });
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(200);
    const args = deps.syncToolModulesMock.mock.calls[0][0] as { userId: string };
    expect(args.userId).toBe('bob');
  });

  it('returns 404 when the skill is not present in the snapshot', async () => {
    const deps = await mockDeps();
    // main has no skills at all.
    deps.snapshotByAgentId.set('main', []);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/ghost/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the skill is pending (not enabled)', async () => {
    const deps = await mockDeps();
    // weather declares a missing credential + unapproved domain → pending.
    deps.snapshotByAgentId.set('main', [pendingSkillEntry]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/weather/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
  });

  it('returns 200 with zero counts and null commit when the skill declares no MCP servers', async () => {
    // Enabled skills with no MCP servers short-circuit: there's nothing to
    // generate, so we never call syncToolModules, and the response mirrors the
    // "no tools discovered" shape from the helper.
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledNoMcpEntry]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/noop/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      commit: null,
      moduleCount: 0,
      toolCount: 0,
    });
    expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
  });

  it('returns 500 with the error message when syncToolModules throws', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);
    deps.syncToolModulesMock.mockRejectedValueOnce(new Error('mcp server unreachable'));

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('mcp server unreachable');
  });

  it('audit log on success emits skill_tools_refreshed with commit/moduleCount/toolCount', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);
    deps.syncToolModulesMock.mockResolvedValueOnce({
      commit: 'deadbeef',
      changed: true,
      moduleCount: 4,
      toolCount: 7,
    });
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(200);
    expect(auditLog).toHaveBeenCalledTimes(1);
    const call = auditLog.mock.calls[0][0] as {
      action: string;
      args: Record<string, unknown>;
      result: string;
    };
    expect(call.action).toBe('skill_tools_refreshed');
    expect(call.result).toBe('success');
    expect(call.args).toMatchObject({
      agentId: 'main',
      skillName: 'linear',
      commit: 'deadbeef',
      moduleCount: 4,
      toolCount: 7,
    });
  });

  it('audit log on failure emits skill_tools_refreshed with result=error and error message', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);
    deps.syncToolModulesMock.mockRejectedValueOnce(new Error('mcp server unreachable'));
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(500);
    expect(auditLog).toHaveBeenCalledTimes(1);
    const call = auditLog.mock.calls[0][0] as {
      action: string;
      args: Record<string, unknown>;
      result: string;
    };
    expect(call.action).toBe('skill_tools_refreshed');
    expect(call.result).toBe('error');
    expect(call.args).toMatchObject({
      agentId: 'main',
      skillName: 'linear',
      error: 'mcp server unreachable',
    });
  });

  it('returns 503 when agentSkillsDeps is missing', async () => {
    const deps = await mockDeps({ withAgentSkills: false });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      token: 'test-secret-token',
      method: 'POST',
    });

    expect(res.status).toBe(503);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });

  it('returns 401 when bearer token is missing', async () => {
    const deps = await mockDeps();
    deps.snapshotByAgentId.set('main', [enabledLinearEntry]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/agents/main/skills/linear/refresh-tools', {
      method: 'POST',
    });

    expect(res.status).toBe(401);
    expect(deps.syncToolModulesMock).not.toHaveBeenCalled();
  });
});
