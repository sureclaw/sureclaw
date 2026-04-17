// tests/host/server-admin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

// Mock identity-reader to return controlled identity
vi.mock('../../src/host/identity-reader.js', () => ({
  readIdentityForAgent: vi.fn(async () => ({ soul: 'Test soul.', identity: 'Test identity.' })),
  loadIdentityFromGit: vi.fn(() => ({})),
  fetchIdentityFromRemote: vi.fn(() => ({ gitDir: '/tmp/mock', identity: {} })),
  IDENTITY_FILE_MAP: [],
}));

// Suppress pino output in tests
initLogger({ file: false, level: 'silent' });

function makeConfig(overrides: Partial<Config['admin']> = {}): Config {
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
      token: overrides.token ?? 'test-secret-token',
      port: overrides.port ?? 8080,
      ...overrides,
    },
  } as Config;
}

async function mockDeps(configOverrides: Partial<Config['admin']> = {}): Promise<AdminDeps> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
  const config = makeConfig(configOverrides);
  const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  await registry.register({ id: 'main', name: 'Main Agent', description: 'Test agent', status: 'active', parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test' });

  return {
    config,
    providers: {
      audit: {
        log: vi.fn().mockResolvedValue(undefined),
        query: vi.fn().mockResolvedValue([
          {
            timestamp: new Date(),
            sessionId: 'test-session',
            action: 'llm_call',
            args: {},
            result: 'success',
            durationMs: 100,
          },
        ]),
      },
      storage: {
        documents: {
          list: vi.fn().mockImplementation((collection: string) =>
            collection === 'identity' ? Promise.resolve(['main/persona.md']) : Promise.resolve([])),
          get: vi.fn().mockResolvedValue('You are a helpful assistant.'),
        },
      },
      memory: {
        recall: vi.fn().mockResolvedValue([]),
      },
      workspace: {
        getRepoUrl: vi.fn().mockResolvedValue({ url: 'file:///mock-repo', created: false }),
        close: vi.fn(),
      },
    } as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
  };
}

function startTestServer(
  handler: ReturnType<typeof createAdminHandler>,
): Promise<{ server: Server; port: number; tmpDir?: string }> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/admin')) {
        await handler(req, res, url.split('?')[0]);
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
): Promise<{ status: number; body: unknown; headers: Record<string, string> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;

  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  const resHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => { resHeaders[k] = v; });
  return { status: res.status, body, headers: resHeaders };
}

describe('admin auth', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => {
    server.close();
  });

  it('rejects requests without token', async () => {
    const res = await fetchAdmin(port, '/admin/api/status');
    expect(res.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const res = await fetchAdmin(port, '/admin/api/status', { token: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts requests with correct token', async () => {
    const res = await fetchAdmin(port, '/admin/api/status', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
  });

  it('rate-limits auth failures', async () => {
    // Make 21 bad requests to trigger rate limiting
    for (let i = 0; i < 21; i++) {
      await fetchAdmin(port, '/admin/api/status', { token: 'wrong' });
    }
    const res = await fetchAdmin(port, '/admin/api/status', { token: 'wrong' });
    expect(res.status).toBe(429);
  });

  it('auto-generates token when not configured', async () => {
    const deps = await mockDeps({ token: undefined });
    createAdminHandler(deps);
    expect(deps.config.admin.token).toBeDefined();
    expect(deps.config.admin.token!.length).toBeGreaterThanOrEqual(32);
  });

  it('skips auth for localhost in local dev mode', async () => {
    server.close();
    const deps = await mockDeps();
    deps.localDevMode = true;
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    // No token provided — should succeed because localDevMode + localhost
    const res = await fetchAdmin(port, '/admin/api/status');
    expect(res.status).toBe(200);
  });

  it('still requires auth when localDevMode is false', async () => {
    server.close();
    const deps = await mockDeps();
    deps.localDevMode = false;
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/status');
    expect(res.status).toBe(401);
  });
});

describe('GET /admin/api/status', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns server health, uptime, profile, agent count', async () => {
    const res = await fetchAdmin(port, '/admin/api/status', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data.status).toBe('ok');
    expect(typeof data.uptime).toBe('number');
    expect(data.profile).toBe('balanced');
    expect(data.agents).toEqual(expect.objectContaining({ active: expect.any(Number), total: expect.any(Number) }));
  });
});

describe('GET /admin/api/agents', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns list of agents', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const agents = res.body as unknown[];
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(1); // ensureDefault creates 'main'
  });
});

describe('GET /admin/api/agents/:id', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns single agent detail with children', async () => {
    // First get agents to find the main agent
    const listRes = await fetchAdmin(port, '/admin/api/agents', { token: 'test-secret-token' });
    const agents = listRes.body as Array<{ id: string }>;
    const agentId = agents[0].id;

    const res = await fetchAdmin(port, `/admin/api/agents/${agentId}`, { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(data.id).toBe(agentId);
    expect(Array.isArray(data.children)).toBe(true);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/nonexistent', { token: 'test-secret-token' });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /admin/api/agents/:id', () => {
  let server: Server;
  let port: number;

  afterEach(() => { server.close(); });

  it('archives agent (soft delete)', async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/agents/main', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = res.body as { ok: boolean; agentId: string };
    expect(data.ok).toBe(true);
    expect(data.agentId).toBe('main');
  });

  it('archives agent without error when sandbox has no deletePvc', async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    (deps.providers as any).sandbox = {};
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/agents/main', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    const data = res.body as { ok: boolean; agentId: string };
    expect(data.ok).toBe(true);
  });

  // deletePvc tests removed — workspace is now git-backed, no PVC cleanup needed

  it('returns 404 for unknown agent', async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/agents/nonexistent', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/api/audit', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns audit entries', async () => {
    const res = await fetchAdmin(port, '/admin/api/audit', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const entries = res.body as unknown[];
    expect(Array.isArray(entries)).toBe(true);
  });

  it('passes query params as filter', async () => {
    const res = await fetchAdmin(port, '/admin/api/audit?action=llm_call&limit=10', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
  });
});

describe('GET /admin/api/config', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns config with redacted credentials', async () => {
    const res = await fetchAdmin(port, '/admin/api/config', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    const admin = data.admin as Record<string, unknown> | undefined;
    expect(admin?.token).toBeUndefined();
  });
});

describe('GET /admin/api/events', () => {
  let server: Server;
  let port: number;
  let deps: AdminDeps;

  beforeEach(async () => {
    _rateLimits.clear();
    deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('opens SSE stream and receives events', async () => {
    const controller = new AbortController();
    const events: string[] = [];

    const ssePromise = fetch(
      `http://127.0.0.1:${port}/admin/api/events?token=test-secret-token`,
      { signal: controller.signal },
    ).then(async (res) => {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();

      // Read a few chunks
      for (let i = 0; i < 3; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }
    });

    // Give SSE time to connect, then emit an event
    await new Promise(r => setTimeout(r, 100));
    deps.eventBus.emit({
      type: 'test.event',
      requestId: 'test-req',
      timestamp: Date.now(),
      data: { hello: 'world' },
    });

    await new Promise(r => setTimeout(r, 100));
    controller.abort();

    try { await ssePromise; } catch { /* AbortError expected */ }

    const allText = events.join('');
    expect(allText).toContain(':connected');
    expect(allText).toContain('test.event');
  });
});

describe('GET /admin/api/agents/:id/identity', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns identity documents for the agent', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/main/identity', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const docs = res.body as Array<{ key: string; content: string }>;
    expect(docs).toEqual([
      { key: 'SOUL.md', content: 'Test soul.' },
      { key: 'IDENTITY.md', content: 'Test identity.' },
    ]);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/nonexistent/identity', { token: 'test-secret-token' });
    expect(res.status).toBe(404);
  });
});

describe('GET /admin/api/agents/:id/skills', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('returns empty skill list when workspace has no downloadScope', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/main/skills', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as Array<{ name: string }>;
    expect(data).toEqual([]);
  });

  it('returns 404 for unknown agent', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/nonexistent/skills', { token: 'test-secret-token' });
    expect(res.status).toBe(404);
  });
});


describe('tab endpoints handle provider errors gracefully', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
    const config = makeConfig();
    const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
    await registry.register({ id: 'main', name: 'Main Agent', description: 'Test agent', status: 'active', parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test' });

    const deps: AdminDeps = {
      config,
      providers: {
        audit: {
          log: vi.fn().mockResolvedValue(undefined),
          query: vi.fn().mockResolvedValue([]),
        },
        storage: {
          documents: {
            list: vi.fn().mockRejectedValue(new Error('database connection lost')),
            get: vi.fn().mockRejectedValue(new Error('database connection lost')),
          },
        },
        memory: {
          list: vi.fn().mockRejectedValue(new Error('memory provider error')),
        },
        workspace: {
          getRepoUrl: vi.fn().mockResolvedValue({ url: 'file:///mock-repo', created: false }),
          close: vi.fn(),
        },
      } as unknown as AdminDeps['providers'],
      eventBus: createEventBus(),
      agentRegistry: registry,
      startTime: Date.now() - 60_000,
    };

    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('identity endpoint returns 500 with specific error when provider fails', async () => {
    // Mock readIdentityForAgent to throw for this test
    const { readIdentityForAgent } = await import('../../src/host/identity-reader.js');
    vi.mocked(readIdentityForAgent).mockRejectedValueOnce(new Error('git fetch failed'));
    const res = await fetchAdmin(port, '/admin/api/agents/main/identity', { token: 'test-secret-token' });
    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('Failed to read identity');
    expect(body.error.message).toContain('git fetch failed');
  });

  it('skills endpoint returns 500 with specific error when provider fails', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/main/skills', { token: 'test-secret-token' });
    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('Failed to list skills');
  });


  it('memory endpoint returns 500 with specific error when provider fails', async () => {
    const res = await fetchAdmin(port, '/admin/api/agents/main/memory', { token: 'test-secret-token' });
    expect(res.status).toBe(500);
    const body = res.body as { error: { message: string } };
    expect(body.error.message).toContain('Failed to list memory entries');
    expect(body.error.message).toContain('memory provider error');
  });
});

describe('setup endpoints', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('GET /admin/api/setup/status returns setup status', async () => {
    const res = await fetchAdmin(port, '/admin/api/setup/status');
    expect(res.status).toBe(200);
    const data = res.body as Record<string, unknown>;
    expect(typeof data.configured).toBe('boolean');
  });
});

describe('proxy domain management endpoints', () => {
  let server: Server;
  let port: number;
  let domainList: ProxyDomainList;

  beforeEach(async () => {
    _rateLimits.clear();
    domainList = new ProxyDomainList();
    const deps = await mockDeps();
    deps.domainList = domainList;
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;
  });

  afterEach(() => { server.close(); });

  it('GET /admin/api/proxy/domains returns allowed and pending lists', async () => {
    domainList.addPending('evil.com', 'sess-1');
    const res = await fetchAdmin(port, '/admin/api/proxy/domains', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as { allowed: string[]; pending: Array<{ domain: string }> };
    expect(Array.isArray(data.allowed)).toBe(true);
    expect(data.allowed.length).toBeGreaterThan(0); // builtins
    expect(data.pending).toEqual([
      expect.objectContaining({ domain: 'evil.com', sessionId: 'sess-1' }),
    ]);
  });

  it('GET /admin/api/proxy/domains returns empty when domainList is not set', async () => {
    // Recreate without domainList
    server.close();
    const deps = await mockDeps();
    // deps.domainList is undefined
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/proxy/domains', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
    const data = res.body as { allowed: string[]; pending: unknown[] };
    expect(data.allowed).toEqual([]);
    expect(data.pending).toEqual([]);
  });

  it('POST /admin/api/proxy/domains/approve moves pending to allowed', async () => {
    domainList.addPending('example.com', 'sess-1');
    const res = await fetchAdmin(port, '/admin/api/proxy/domains/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: { domain: 'example.com' },
    });
    expect(res.status).toBe(200);
    const data = res.body as { ok: boolean; domain: string };
    expect(data.ok).toBe(true);
    expect(data.domain).toBe('example.com');

    // Verify domain is now allowed and no longer pending
    expect(domainList.isAllowed('example.com')).toBe(true);
    expect(domainList.getPending()).toEqual([]);
  });

  it('POST /admin/api/proxy/domains/approve rejects missing domain', async () => {
    const res = await fetchAdmin(port, '/admin/api/proxy/domains/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/api/proxy/domains/deny removes pending domain', async () => {
    domainList.addPending('malware.com', 'sess-1');
    const res = await fetchAdmin(port, '/admin/api/proxy/domains/deny', {
      token: 'test-secret-token',
      method: 'POST',
      body: { domain: 'malware.com' },
    });
    expect(res.status).toBe(200);
    const data = res.body as { ok: boolean; domain: string };
    expect(data.ok).toBe(true);
    expect(data.domain).toBe('malware.com');

    // Verify domain is NOT allowed and no longer pending
    expect(domainList.isAllowed('malware.com')).toBe(false);
    expect(domainList.getPending()).toEqual([]);
  });

  it('POST /admin/api/proxy/domains/deny rejects missing domain', async () => {
    const res = await fetchAdmin(port, '/admin/api/proxy/domains/deny', {
      token: 'test-secret-token',
      method: 'POST',
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it('POST /admin/api/proxy/domains/approve returns 500 when domainList is not configured', async () => {
    server.close();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/proxy/domains/approve', {
      token: 'test-secret-token',
      method: 'POST',
      body: { domain: 'example.com' },
    });
    expect(res.status).toBe(500);
  });

  it('POST /admin/api/proxy/domains/deny returns 500 when domainList is not configured', async () => {
    server.close();
    const deps = await mockDeps();
    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/proxy/domains/deny', {
      token: 'test-secret-token',
      method: 'POST',
      body: { domain: 'example.com' },
    });
    expect(res.status).toBe(500);
  });
});

describe('AdminDeps Phase 5 skill fields (back-compat)', () => {
  let server: Server;
  let port: number;

  afterEach(() => { server?.close(); });

  it('accepts skillStateStore, reconcileAgent, defaultUserId without breaking existing endpoints', async () => {
    _rateLimits.clear();
    const deps = await mockDeps();

    // Phase 5: stub SkillStateStore — every method a vi.fn() with reasonable defaults.
    deps.skillStateStore = {
      getPriorStates: vi.fn().mockResolvedValue(new Map()),
      getStates: vi.fn().mockResolvedValue([]),
      putStates: vi.fn().mockResolvedValue(undefined),
      putSetupQueue: vi.fn().mockResolvedValue(undefined),
      getSetupQueue: vi.fn().mockResolvedValue([]),
      putStatesAndQueue: vi.fn().mockResolvedValue(undefined),
    };
    deps.reconcileAgent = vi.fn().mockResolvedValue({ skills: 0, events: 0 });
    deps.defaultUserId = 'test-user';

    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    // Hitting /admin/api/status with correct token should still return 200 —
    // adding the new optional deps must not break existing endpoints.
    const res = await fetchAdmin(port, '/admin/api/status', { token: 'test-secret-token' });
    expect(res.status).toBe(200);
  });
});

describe('MCP server admin syncs to McpConnectionManager', () => {
  let server: Server;
  let port: number;

  afterEach(() => { server?.close(); });

  it('POST /admin/api/mcp-servers syncs new server to manager', async () => {
    const deps = await mockDeps();
    deps.localDevMode = true;

    // Mock database provider with in-memory mcp_servers
    const mcpRows: Array<{ id: string; name: string; url: string; headers: string | null; enabled: number; created_at: string; updated_at: string }> = [];
    deps.providers = {
      ...deps.providers,
      database: {
        type: 'sqlite',
        db: {
          insertInto: () => ({
            values: (vals: Record<string, unknown>) => ({
              execute: async () => { mcpRows.push(vals as any); },
            }),
          }),
        },
        close: vi.fn(),
      },
    } as any;

    // Create a real McpConnectionManager
    const { McpConnectionManager } = await import('../../src/plugins/mcp-manager.js');
    const mcpManager = new McpConnectionManager();
    deps.mcpManager = mcpManager;

    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    const res = await fetchAdmin(port, '/admin/api/mcp-servers', {
      method: 'POST',
      body: { name: 'linear', url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer tok_123' } },
    });
    expect(res.status).toBe(201);

    // Verify manager has the server with correct headers
    const servers = mcpManager.listServersWithMeta('_');
    const linear = servers.find(s => s.name === 'linear');
    expect(linear).toBeDefined();
    expect(linear!.url).toBe('https://mcp.linear.app/mcp');
    expect(linear!.headers).toEqual({ Authorization: 'Bearer tok_123' });
  });

  it('DELETE /admin/api/mcp-servers/:name removes server from manager', async () => {
    const deps = await mockDeps();
    deps.localDevMode = true;

    deps.providers = {
      ...deps.providers,
      database: {
        type: 'sqlite',
        db: {
          deleteFrom: () => ({
            where: () => ({
              execute: async () => {},
              executeTakeFirst: async () => ({ numDeletedRows: 1n }),
            }),
          }),
        },
        close: vi.fn(),
      },
    } as any;

    const { McpConnectionManager } = await import('../../src/plugins/mcp-manager.js');
    const mcpManager = new McpConnectionManager();
    mcpManager.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp' }, { source: 'database' });
    deps.mcpManager = mcpManager;

    const handler = createAdminHandler(deps);
    const result = await startTestServer(handler);
    server = result.server;
    port = result.port;

    expect(mcpManager.listServers('_')).toHaveLength(1);

    const res = await fetchAdmin(port, '/admin/api/mcp-servers/linear', {
      method: 'DELETE',
    });
    expect(res.status).toBe(200);

    // Verify manager no longer has the server
    expect(mcpManager.listServers('_')).toHaveLength(0);
  });
});
