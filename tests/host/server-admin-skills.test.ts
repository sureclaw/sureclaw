// tests/host/server-admin-skills.test.ts
//
// Phase 5 Task 2: GET /admin/api/skills/setup — list pending setup cards grouped by agent.
// Mirrors the fixture patterns from server-admin.test.ts; duplication is intentional for clarity.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import type { SetupRequest, SkillState } from '../../src/host/skills/types.js';
import type { SkillStateStore } from '../../src/host/skills/state-store.js';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';
import {
  createCredentialRequestQueue,
  type CredentialRequest,
  type CredentialRequestQueue,
} from '../../src/host/credential-request-queue.js';
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
  withStateStore?: boolean;
  withReconcile?: boolean;
  withDomainList?: boolean;
  withCredentials?: boolean;
  withCredentialRequestQueue?: boolean;
  defaultUserId?: string;
  reconcileImpl?: (agentId: string, ref: string) => Promise<{ skills: number; events: number }>;
  getSetupQueueImpl?: (agentId: string) => Promise<SetupRequest[]>;
  getStatesImpl?: (agentId: string) => Promise<SkillState[]>;
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<AdminDeps> {
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
    providers.credentials = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      listScopePrefix: vi.fn().mockResolvedValue([]),
    };
  }

  const deps: AdminDeps = {
    config,
    providers: providers as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
  };

  if (opts.withStateStore !== false) {
    const getSetupQueue = opts.getSetupQueueImpl
      ? vi.fn().mockImplementation(opts.getSetupQueueImpl)
      : vi.fn().mockResolvedValue([] as SetupRequest[]);
    const getStates = opts.getStatesImpl
      ? vi.fn().mockImplementation(opts.getStatesImpl)
      : vi.fn().mockResolvedValue([] as SkillState[]);
    deps.skillStateStore = {
      getPriorStates: vi.fn().mockResolvedValue(new Map()),
      getStates,
      putStates: vi.fn().mockResolvedValue(undefined),
      putSetupQueue: vi.fn().mockResolvedValue(undefined),
      getSetupQueue,
      putStatesAndQueue: vi.fn().mockResolvedValue(undefined),
    } as unknown as SkillStateStore;
  }

  if (opts.withDomainList !== false) {
    deps.domainList = new ProxyDomainList();
  }

  if (opts.withReconcile !== false) {
    deps.reconcileAgent = opts.reconcileImpl
      ? vi.fn().mockImplementation(opts.reconcileImpl)
      : vi.fn().mockResolvedValue({ skills: 0, events: 0 });
  }

  if (opts.defaultUserId !== undefined) {
    deps.defaultUserId = opts.defaultUserId;
  }

  if (opts.withCredentialRequestQueue) {
    deps.credentialRequestQueue = createCredentialRequestQueue();
  }

  return deps;
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

describe('GET /admin/api/skills/setup', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('returns cards grouped by agent (only agents with non-empty queues)', async () => {
    const deps = await mockDeps({
      registerOther: true,
      getSetupQueueImpl: async (agentId) => {
        if (agentId === 'main') return [mainCard];
        return [];
      },
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
    expect(body.agents[0].cards).toEqual([mainCard]);
  });

  it('returns empty agents array when no agent has queue entries', async () => {
    const deps = await mockDeps({
      registerOther: true,
      getSetupQueueImpl: async () => [],
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ agents: [] });
  });

  it('returns 503 with "Skills not configured" when skillStateStore is missing', async () => {
    const deps = await mockDeps({ withStateStore: false });
    expect(deps.skillStateStore).toBeUndefined();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(503);
    // sendError() wraps the message in { error: { message, type, code } } — see src/host/server-http.ts.
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toBe('Skills not configured');
  });

  it('excludes archived agents from the result', async () => {
    // Archived agent has a queue entry — it must still be excluded.
    const deps = await mockDeps({
      registerArchived: true,
      getSetupQueueImpl: async (agentId) => {
        if (agentId === 'archived') return [{ ...mainCard, skillName: 'ghost' }];
        return [];
      },
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ agentId: string }> };
    expect(body.agents.map(a => a.agentId)).not.toContain('archived');
    expect(body.agents).toEqual([]);
  });

  it('preserves card order and all fields verbatim from getSetupQueue', async () => {
    const cards: SetupRequest[] = [
      {
        skillName: 'alpha',
        description: 'First skill',
        missingCredentials: [
          { envName: 'A_TOKEN', authType: 'api_key', scope: 'agent' },
        ],
        unapprovedDomains: ['a.example.com', 'b.example.com'],
        mcpServers: [{ name: 'alpha-mcp', url: 'https://a.example.com/mcp' }],
      },
      {
        skillName: 'beta',
        description: 'Second skill',
        missingCredentials: [
          {
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
          },
        ],
        unapprovedDomains: [],
        mcpServers: [],
      },
    ];
    const deps = await mockDeps({
      getSetupQueueImpl: async () => cards,
    });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { agents: Array<{ cards: SetupRequest[] }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].cards).toEqual(cards);
    // Order preserved
    expect(body.agents[0].cards[0].skillName).toBe('alpha');
    expect(body.agents[0].cards[1].skillName).toBe('beta');
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

  it('happy path: agent-scoped credential stored at agent:<name>, domain approved, reconcile + audit called', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async (id) => (id === 'main' ? [weatherAgentScoped] : []),
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
    const approvePending = vi.spyOn(deps.domainList!, 'approvePending');
    const reconcile = deps.reconcileAgent as ReturnType<typeof vi.fn>;
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

    expect(credsSet).toHaveBeenCalledTimes(1);
    expect(credsSet).toHaveBeenCalledWith('W_KEY', 'secret-123', 'agent:test-agent');

    expect(approvePending).toHaveBeenCalledWith('api.weather.com');

    expect(reconcile).toHaveBeenCalledWith('main', 'refs/heads/main');

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

  it('happy path: user-scoped credential with explicit userId writes at user:<agent>:<userId>', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherUserScoped],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
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
    expect(credsSet).toHaveBeenCalledWith('W_KEY', 's', 'user:test-agent:alice');
  });

  it('user scope without userId falls back to defaultUserId', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherUserScoped],
      defaultUserId: 'bob',
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
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
    expect(credsSet).toHaveBeenCalledWith('W_KEY', 's', 'user:test-agent:bob');
  });

  it("user scope without userId + without defaultUserId falls back to 'admin'", async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherUserScoped],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
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
    expect(credsSet).toHaveBeenCalledWith('W_KEY', 's', 'user:test-agent:admin');
  });

  it('rejects unexpected credential envName with 400; nothing applied', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherAgentScoped],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
    const approvePending = vi.spyOn(deps.domainList!, 'approvePending');
    const reconcile = deps.reconcileAgent as ReturnType<typeof vi.fn>;
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
    expect(credsSet).not.toHaveBeenCalled();
    expect(approvePending).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects unexpected domain with 400; nothing applied', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherAgentScoped],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
    const approvePending = vi.spyOn(deps.domainList!, 'approvePending');
    const reconcile = deps.reconcileAgent as ReturnType<typeof vi.fn>;
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
    expect(credsSet).not.toHaveBeenCalled();
    expect(approvePending).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('rejects OAuth credential with 400 and clear message', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherOauth],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
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
    expect(credsSet).not.toHaveBeenCalled();
  });

  it('returns 404 when skill is not in the setup queue', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [],
    });
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

  it('returns 503 when skillStateStore is missing', async () => {
    const deps = await mockDeps({ withStateStore: false });
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

  it('returns 503 when reconcileAgent is missing', async () => {
    const deps = await mockDeps({
      withReconcile: false,
      getSetupQueueImpl: async () => [weatherAgentScoped],
    });
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
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherAgentScoped],
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
    const approvePending = vi.spyOn(deps.domainList!, 'approvePending');
    const reconcile = deps.reconcileAgent as ReturnType<typeof vi.fn>;
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
    expect(credsSet).not.toHaveBeenCalled();
    expect(approvePending).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('reconcile failure does not fail the approve — 200 with fresh state returned', async () => {
    const freshState: SkillState = {
      name: 'weather',
      kind: 'enabled',
      description: 'Weather lookups',
    };
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherAgentScoped],
      getStatesImpl: async () => [freshState],
      reconcileImpl: async () => { throw new Error('reconcile exploded'); },
    });
    const credsSet = deps.providers.credentials.set as ReturnType<typeof vi.fn>;
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
    const body = res.body as { ok: boolean; state: SkillState };
    expect(body.ok).toBe(true);
    expect(body.state).toEqual(freshState);
    // Credentials were still persisted before the reconcile attempt.
    expect(credsSet).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when audit.log throws — unexpected server errors are not masked as 400', async () => {
    // Regression: the approve route previously wrapped the entire flow in one try/catch
    // that reported every throw as 400 "Invalid request". That masked real server-side
    // failures (audit.log rejection, getStates exploding) as client bugs. The catch is
    // now narrowed to JSON.parse only, so unexpected throws fall through to the outer
    // HTTP handler, which returns 500.
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherAgentScoped],
    });
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

  it('happy path: removes the matching card, persists the new queue, emits audit', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async (id) => (id === 'main' ? [linearCard, weatherCard] : []),
    });
    const putSetupQueue = deps.skillStateStore!.putSetupQueue as ReturnType<typeof vi.fn>;
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });

    expect(putSetupQueue).toHaveBeenCalledTimes(1);
    expect(putSetupQueue).toHaveBeenCalledWith('main', [weatherCard]);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('skill_dismissed');
    expect(auditCall.args).toEqual({ agentId: 'main', skillName: 'linear' });
  });

  it('idempotent: skill not in queue → 200 { removed: false }, no write, no audit', async () => {
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [weatherCard],
    });
    const putSetupQueue = deps.skillStateStore!.putSetupQueue as ReturnType<typeof vi.fn>;
    const auditLog = deps.providers.audit.log as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: false });
    expect(putSetupQueue).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('decodes URL-encoded skill names (segments with hyphens and percent-encoding)', async () => {
    const fooBarCard: SetupRequest = { ...linearCard, skillName: 'foo-bar' };
    const deps = await mockDeps({
      getSetupQueueImpl: async () => [fooBarCard],
    });
    const putSetupQueue = deps.skillStateStore!.putSetupQueue as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/foo-bar', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });
    expect(putSetupQueue).toHaveBeenCalledWith('main', []);
  });

  it('returns 503 "Skills not configured" when skillStateStore is missing', async () => {
    const deps = await mockDeps({ withStateStore: false });
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

  it("doesn't touch other agents' queues when dismissing from one agent", async () => {
    // Each agent has its own queue. Dismissing from `main` must only write back to `main`.
    const deps = await mockDeps({
      registerOther: true,
      getSetupQueueImpl: async (id) => {
        if (id === 'main') return [linearCard, weatherCard];
        if (id === 'other') return [linearCard]; // `other` also has a linear card
        return [];
      },
    });
    const putSetupQueue = deps.skillStateStore!.putSetupQueue as ReturnType<typeof vi.fn>;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/setup/main/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: true });

    // Only one write — to `main`. `other` is untouched even though its queue also has `linear`.
    expect(putSetupQueue).toHaveBeenCalledTimes(1);
    expect(putSetupQueue).toHaveBeenCalledWith('main', [weatherCard]);
    const agentIdsWritten = putSetupQueue.mock.calls.map(c => c[0]);
    expect(agentIdsWritten).toEqual(['main']);
    expect(agentIdsWritten).not.toContain('other');
  });
});

// ── GET /admin/api/credentials/requests (Phase 5 Task 5) ───────────────────

function mkCredReq(overrides: Partial<CredentialRequest> = {}): CredentialRequest {
  return {
    sessionId: 'sess-1',
    envName: 'LINEAR_TOKEN',
    agentName: 'main',
    userId: 'alice',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('GET /admin/api/credentials/requests', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('returns empty when the queue has nothing', async () => {
    const deps = await mockDeps({ withCredentialRequestQueue: true });
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/credentials/requests', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });

  it('returns what is in the queue', async () => {
    const deps = await mockDeps({ withCredentialRequestQueue: true });
    const q = deps.credentialRequestQueue as CredentialRequestQueue;
    const req1 = mkCredReq({ envName: 'A_TOKEN' });
    const req2 = mkCredReq({ sessionId: 'sess-2', envName: 'B_TOKEN', userId: undefined });
    q.enqueue(req1);
    q.enqueue(req2);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/credentials/requests', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const body = res.body as { requests: CredentialRequest[] };
    expect(body.requests).toHaveLength(2);
    const envs = body.requests.map((r) => r.envName).sort();
    expect(envs).toEqual(['A_TOKEN', 'B_TOKEN']);
  });

  it('soft-degrades to 200 { requests: [] } when credentialRequestQueue dep is missing', async () => {
    const deps = await mockDeps(); // no withCredentialRequestQueue → dep is undefined
    expect(deps.credentialRequestQueue).toBeUndefined();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/credentials/requests', { token: 'test-secret-token' });
    // Additive feature: absence isn't a 503.
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ requests: [] });
  });
});

describe('POST /admin/api/credentials/provide dequeues the matching request', () => {
  let server: Server;
  let port: number;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(() => {
    server?.close();
  });

  it('removes the matching (sessionId + envName) entry after a successful provide', async () => {
    const deps = await mockDeps({ withCredentialRequestQueue: true });
    const q = deps.credentialRequestQueue as CredentialRequestQueue;
    q.enqueue(mkCredReq({ sessionId: 'sess-X', envName: 'GITHUB_TOKEN' }));
    q.enqueue(mkCredReq({ sessionId: 'sess-X', envName: 'OTHER_TOKEN' })); // different env — must remain

    // Before: both entries present.
    const before = q.snapshot();
    expect(before).toHaveLength(2);
    expect(before.some((r) => r.envName === 'GITHUB_TOKEN')).toBe(true);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/credentials/provide', {
      token: 'test-secret-token',
      method: 'POST',
      body: { envName: 'GITHUB_TOKEN', value: 'ghp_xxx', sessionId: 'sess-X' },
    });
    expect(res.status).toBe(200);

    // After: the matching entry is gone, the unrelated one is still there.
    const after = q.snapshot();
    expect(after).toHaveLength(1);
    expect(after[0].envName).toBe('OTHER_TOKEN');
    expect(after.some((r) => r.envName === 'GITHUB_TOKEN')).toBe(false);
  });
});
