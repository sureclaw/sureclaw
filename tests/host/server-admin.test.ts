// tests/host/server-admin.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { AgentRegistry } from '../../src/host/agent-registry.js';
import { createEventBus } from '../../src/host/event-bus.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initLogger } from '../../src/logger.js';

// Suppress pino output in tests
initLogger({ file: false, level: 'silent' });

function makeConfig(overrides: Partial<Config['admin']> = {}): Config {
  return {
    profile: 'balanced',
    providers: {
      memory: 'file',
      scanner: 'basic',
      channels: [],
      web: 'none',
      browser: 'none',
      credentials: 'keychain',
      skills: 'readonly',
      audit: 'file',
      sandbox: 'subprocess',
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

function mockDeps(configOverrides: Partial<Config['admin']> = {}): AdminDeps {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-admin-test-'));
  const config = makeConfig(configOverrides);
  const registry = new AgentRegistry(join(tmpDir, 'registry.json'));
  registry.ensureDefault();

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
    const deps = mockDeps();
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

  it('auto-generates token when not configured', () => {
    const deps = mockDeps({ token: undefined });
    createAdminHandler(deps);
    expect(deps.config.admin.token).toBeDefined();
    expect(deps.config.admin.token!.length).toBeGreaterThanOrEqual(32);
  });
});

describe('GET /admin/api/status', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = mockDeps();
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
    const deps = mockDeps();
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
    const deps = mockDeps();
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

describe('GET /admin/api/audit', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = mockDeps();
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
    const deps = mockDeps();
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
    deps = mockDeps();
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

describe('setup endpoints', () => {
  let server: Server;
  let port: number;

  beforeEach(async () => {
    _rateLimits.clear();
    const deps = mockDeps();
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
