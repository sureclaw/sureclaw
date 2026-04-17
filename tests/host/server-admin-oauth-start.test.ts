// tests/host/server-admin-oauth-start.test.ts
//
// Phase 6 Task 3: POST /admin/api/skills/oauth/start — admin-initiated OAuth
// flow initiation. Validates the request against the agent's pending setup
// queue, applies admin-registered provider overrides, and returns
// { authUrl, state }.
//
// Modelled after server-admin-oauth-providers.test.ts — same mockDeps
// pattern, same startTestServer/fetchAdmin helpers. Uses REAL stores over
// in-memory SQLite for both the skill state queue and the admin OAuth
// provider registry so the HTTP round-trip exercises the full override
// + encrypted-at-rest path.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import Database from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createAdminHandler, _rateLimits, type AdminDeps } from '../../src/host/server-admin.js';
import type { Config } from '../../src/types.js';
import { createSqliteRegistry } from '../../src/host/agent-registry-db.js';
import { createEventBus } from '../../src/host/event-bus.js';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';
import { runMigrations } from '../../src/utils/migrator.js';
import { adminOAuthMigrations } from '../../src/migrations/admin-oauth-providers.js';
import { skillsMigrations } from '../../src/migrations/skills.js';
import {
  createAdminOAuthProviderStore,
  type AdminOAuthProviderStore,
} from '../../src/host/admin-oauth-providers.js';
import { createSkillStateStore, type SkillStateStore } from '../../src/host/skills/state-store.js';
import { createAdminOAuthFlow, type AdminOAuthFlow } from '../../src/host/admin-oauth-flow.js';
import type { SetupRequest } from '../../src/host/skills/types.js';
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

function oauthCard(overrides: Partial<SetupRequest> = {}): SetupRequest {
  return {
    skillName: 'linear-tracker',
    description: 'Linear issues tracker',
    missingCredentials: [
      {
        envName: 'LINEAR_TOKEN',
        authType: 'oauth',
        scope: 'user',
        oauth: {
          provider: 'linear',
          clientId: 'frontmatter-cid',
          authorizationUrl: 'https://linear.app/oauth/authorize',
          tokenUrl: 'https://api.linear.app/oauth/token',
          scopes: ['read', 'write'],
        },
      },
    ],
    unapprovedDomains: [],
    mcpServers: [],
    ...overrides,
  };
}

interface MockDepsOpts {
  /** When false, do NOT wire a skillStateStore — endpoint must 503. */
  withStateStore?: boolean;
  /** When false, do NOT wire adminOAuthFlow — endpoint must 503. */
  withOAuthFlow?: boolean;
  /** When false, do NOT wire adminOAuthProviderStore — admin overrides unavailable. */
  withOAuthProviderStore?: boolean;
  /** Explicit defaultUserId on deps. */
  defaultUserId?: string;
}

interface MockDepsResult {
  deps: AdminDeps;
  stateStore: SkillStateStore | undefined;
  oauthStore: AdminOAuthProviderStore | undefined;
  adminOAuthFlow: AdminOAuthFlow | undefined;
  auditLog: ReturnType<typeof vi.fn>;
  cleanup: () => Promise<void>;
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<MockDepsResult> {
  const withStateStore = opts.withStateStore !== false;
  const withOAuthFlow = opts.withOAuthFlow !== false;
  const withOAuthProviderStore = opts.withOAuthProviderStore !== false;

  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-oauth-start-test-'));
  const config = makeConfig();
  const registry = await createSqliteRegistry(join(tmpDir, 'registry.db'));
  await registry.register({
    id: 'main', name: 'Main Agent', description: 'Primary agent', status: 'active',
    parentId: null, agentType: 'pi-coding-agent', capabilities: [], createdBy: 'test',
  });

  const auditLog = vi.fn().mockResolvedValue(undefined);

  const providers: Record<string, unknown> = {
    audit: { log: auditLog, query: vi.fn().mockResolvedValue([]) },
    credentials: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      listScopePrefix: vi.fn().mockResolvedValue([]),
    },
  };

  const deps: AdminDeps = {
    config,
    providers: providers as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
  };
  deps.domainList = new ProxyDomainList();

  if (opts.defaultUserId !== undefined) {
    deps.defaultUserId = opts.defaultUserId;
  }

  const closers: Array<() => Promise<void>> = [];

  let stateStore: SkillStateStore | undefined;
  if (withStateStore) {
    const sqliteDb = new Database(':memory:');
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
    const mig = await runMigrations(db, skillsMigrations, 'skills_migration');
    if (mig.error) throw mig.error;
    stateStore = createSkillStateStore(db);
    deps.skillStateStore = stateStore;
    closers.push(async () => { await db.destroy(); });
  }

  let oauthStore: AdminOAuthProviderStore | undefined;
  if (withOAuthProviderStore) {
    const sqliteDb = new Database(':memory:');
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
    const mig = await runMigrations(db, adminOAuthMigrations, 'admin_oauth_migration');
    if (mig.error) throw mig.error;
    const key = randomBytes(32);
    oauthStore = createAdminOAuthProviderStore(db, key);
    deps.adminOAuthProviderStore = oauthStore;
    closers.push(async () => { await db.destroy(); });
  }

  let adminOAuthFlow: AdminOAuthFlow | undefined;
  if (withOAuthFlow) {
    adminOAuthFlow = createAdminOAuthFlow();
    deps.adminOAuthFlow = adminOAuthFlow;
  }

  return {
    deps,
    stateStore,
    oauthStore,
    adminOAuthFlow,
    auditLog,
    cleanup: async () => { for (const c of closers) await c(); },
  };
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

describe('POST /admin/api/skills/oauth/start', () => {
  let server: Server;
  let port: number;
  let cleanupStore: (() => Promise<void>) | undefined;

  beforeEach(() => {
    _rateLimits.clear();
  });

  afterEach(async () => {
    server?.close();
    if (cleanupStore) await cleanupStore();
    cleanupStore = undefined;
  });

  it('happy path: frontmatter-only clientId, returns { authUrl, state }', async () => {
    const { deps, stateStore, adminOAuthFlow, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { authUrl: string; state: string };
    expect(typeof body.authUrl).toBe('string');
    expect(typeof body.state).toBe('string');

    const url = new URL(body.authUrl);
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('frontmatter-cid');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).not.toBeNull();
    expect(challenge!.length).toBeGreaterThan(0);
    expect(url.searchParams.get('state')).toBe(body.state);
    expect(url.searchParams.get('scope')).toBe('read write');

    const redirectUri = url.searchParams.get('redirect_uri')!;
    expect(redirectUri.endsWith('/v1/oauth/callback/linear')).toBe(true);

    // Flow stored in the in-memory map.
    expect(adminOAuthFlow!.size()).toBe(1);

    // Audit: oauth_start with hasAdminProvider=false.
    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('oauth_start');
    expect(auditCall.args).toEqual({
      agentId: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      provider: 'linear',
      hasAdminProvider: false,
    });
  });

  it('admin-registered override: admin clientId + redirectUri win; secret stored but NEVER leaks', async () => {
    const { deps, stateStore, oauthStore, adminOAuthFlow, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    await oauthStore!.upsert({
      provider: 'linear',
      clientId: 'admin-cid',
      clientSecret: 'admin-shh',
      redirectUri: 'https://admin-redirect/cb',
    });

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { authUrl: string; state: string };

    const url = new URL(body.authUrl);
    expect(url.searchParams.get('client_id')).toBe('admin-cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://admin-redirect/cb');
    // Frontmatter clientId must not sneak through.
    expect(body.authUrl).not.toContain('frontmatter-cid');

    // Audit: hasAdminProvider=true.
    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.args).toMatchObject({ provider: 'linear', hasAdminProvider: true });

    // CRITICAL: the secret value must NEVER appear in audit args or the
    // response body.
    expect(JSON.stringify(auditCall)).not.toContain('admin-shh');
    expect(JSON.stringify(res.body)).not.toContain('admin-shh');

    // But the flow's internal state did capture it — claim directly to
    // verify (this is what the callback handler will later exercise).
    const claimed = adminOAuthFlow!.claim(body.state);
    expect(claimed).toBeDefined();
    expect(claimed!.clientSecret).toBe('admin-shh');
    expect(claimed!.clientId).toBe('admin-cid');
  });

  it('skill not in setup queue → 404', async () => {
    const { deps, stateStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard({ skillName: 'other-skill' })]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'not-in-queue',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { message: string } }).error.message).toBe(
      'No pending setup for this skill',
    );
  });

  it('envName not in missingCredentials → 404', async () => {
    const { deps, stateStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'SOMETHING_ELSE',
      },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { message: string } }).error.message).toBe(
      'No pending OAuth credential for this envName',
    );
  });

  it('api_key credential (not oauth) → 404 (OAuth-only)', async () => {
    const { deps, stateStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [
      {
        skillName: 'api-only',
        description: 'API key skill',
        missingCredentials: [{ envName: 'FOO_API_KEY', authType: 'api_key', scope: 'user' }],
        unapprovedDomains: [],
        mcpServers: [],
      },
    ]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'api-only',
        envName: 'FOO_API_KEY',
      },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { message: string } }).error.message).toBe(
      'No pending OAuth credential for this envName',
    );
  });

  it('agent not in registry → 404', async () => {
    const { deps, stateStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'does-not-exist',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(404);
    expect((res.body as { error: { message: string } }).error.message).toBe('Agent not found');
  });

  it('503 when skillStateStore missing', async () => {
    const { deps, cleanup } = await mockDeps({ withStateStore: false });
    cleanupStore = cleanup;

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: { message: string } }).error.message).toBe('Skills not configured');
  });

  it('503 when adminOAuthFlow missing', async () => {
    const { deps, stateStore, cleanup } = await mockDeps({ withOAuthFlow: false });
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(503);
    expect((res.body as { error: { message: string } }).error.message).toBe('Skills not configured');
  });

  it('Zod validation — missing required fields → 400', async () => {
    const { deps, stateStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: { agentId: 'main' }, // missing skillName + envName
    });
    expect(res.status).toBe(400);
  });

  it('userId fallback chain — body.userId wins over deps.defaultUserId', async () => {
    const { deps, stateStore, adminOAuthFlow, cleanup } = await mockDeps({
      defaultUserId: 'from-deps',
    });
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
        userId: 'from-body',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { authUrl: string; state: string };
    const flow = adminOAuthFlow!.claim(body.state);
    expect(flow).toBeDefined();
    expect(flow!.userId).toBe('from-body');
  });

  it('userId fallback chain — deps.defaultUserId used when body omits it', async () => {
    const { deps, stateStore, adminOAuthFlow, cleanup } = await mockDeps({
      defaultUserId: 'from-deps',
    });
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { authUrl: string; state: string };
    const flow = adminOAuthFlow!.claim(body.state);
    expect(flow).toBeDefined();
    expect(flow!.userId).toBe('from-deps');
  });

  it("userId fallback chain — 'admin' used when both body.userId and deps.defaultUserId are absent", async () => {
    const { deps, stateStore, adminOAuthFlow, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    await stateStore!.putSetupQueue('main', [oauthCard()]);

    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/skills/oauth/start', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        agentId: 'main',
        skillName: 'linear-tracker',
        envName: 'LINEAR_TOKEN',
      },
    });
    expect(res.status).toBe(200);
    const body = res.body as { authUrl: string; state: string };
    const flow = adminOAuthFlow!.claim(body.state);
    expect(flow).toBeDefined();
    expect(flow!.userId).toBe('admin');
  });
});
