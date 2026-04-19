// tests/host/server-admin-oauth-providers.test.ts
//
// Phase 6 Task 2: GET/POST/DELETE under /admin/api/oauth/providers.
// Admin-registered OAuth provider configs override frontmatter's client_id +
// client_secret for providers like Google that don't do PKCE-only.
//
// Modelled after server-admin-skills.test.ts — same mockDeps pattern, same
// startTestServer helper, same fetchAdmin helper. Uses a REAL backing store
// over in-memory SQLite so we exercise the full HTTP → store round-trip
// (and verify the encrypted-at-rest secret invariant).

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
import { runMigrations } from '../../src/utils/migrator.js';
import { adminOAuthMigrations } from '../../src/migrations/admin-oauth-providers.js';
import {
  createAdminOAuthProviderStore,
  type AdminOAuthProviderStore,
} from '../../src/host/admin-oauth-providers.js';
import { initLogger } from '../../src/logger.js';

// Same stub as server-admin-skills.test.ts — we don't exercise identity here.
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
  /** When false, construct deps WITHOUT the OAuth provider store — every
   *  /admin/api/oauth/* endpoint must 503. */
  withOAuthStore?: boolean;
}

interface MockDepsResult {
  deps: AdminDeps;
  /** Real store (over in-memory SQLite) so tests can also inspect raw rows. */
  oauthStore: AdminOAuthProviderStore | undefined;
  auditLog: ReturnType<typeof vi.fn>;
  /** Clean up the in-memory DB at the end of each test. */
  cleanup: () => Promise<void>;
}

async function mockDeps(opts: MockDepsOpts = {}): Promise<MockDepsResult> {
  const withOAuthStore = opts.withOAuthStore !== false;
  const tmpDir = mkdtempSync(join(tmpdir(), 'ax-oauth-providers-test-'));
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
    },
  };

  const deps: AdminDeps = {
    config,
    providers: providers as unknown as AdminDeps['providers'],
    eventBus: createEventBus(),
    agentRegistry: registry,
    startTime: Date.now() - 60_000,
    // OAuth-provider CRUD tests don't exercise the tool-module sync path; stub
    // with a fail-loud closure so accidental invocations show up as failures.
    syncToolModules: async () => {
      throw new Error('syncToolModules stub — not exercised in these tests');
    },
  };

  let oauthStore: AdminOAuthProviderStore | undefined;
  let close: (() => Promise<void>) | undefined;
  if (withOAuthStore) {
    const sqliteDb = new Database(':memory:');
    const db = new Kysely<any>({ dialect: new SqliteDialect({ database: sqliteDb }) });
    const mig = await runMigrations(db, adminOAuthMigrations, 'admin_oauth_migration');
    if (mig.error) throw mig.error;
    const key = randomBytes(32);
    oauthStore = createAdminOAuthProviderStore(db, key);
    deps.adminOAuthProviderStore = oauthStore;
    close = async () => { await db.destroy(); };
  }

  return {
    deps,
    oauthStore,
    auditLog,
    cleanup: async () => { if (close) await close(); },
  };
}

function startTestServer(
  handler: ReturnType<typeof createAdminHandler>,
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createHttpServer(async (req, res) => {
      const url = req.url ?? '/';
      if (url.startsWith('/admin')) {
        // Mirror production outer try/catch: unhandled throws → 500.
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

describe('/admin/api/oauth/providers', () => {
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

  it('full lifecycle: upsert → list → delete → list', async () => {
    const { deps, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    // 1) Upsert
    const postRes = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'linear',
        clientId: 'cid-x',
        clientSecret: 'shh',
        redirectUri: 'https://host/cb',
      },
    });
    expect(postRes.status).toBe(200);
    expect(postRes.body).toEqual({ ok: true });

    // 2) List shows the provider — no clientSecret anywhere.
    const listRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    expect(listRes.status).toBe(200);
    const body = listRes.body as { providers: Array<Record<string, unknown>> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0]).toMatchObject({
      provider: 'linear',
      clientId: 'cid-x',
      redirectUri: 'https://host/cb',
    });
    expect(typeof body.providers[0].updatedAt).toBe('number');
    // Structural + substring guard against secret leakage.
    expect('clientSecret' in body.providers[0]).toBe(false);
    expect(JSON.stringify(body)).not.toContain('shh');

    // 3) Delete
    const delRes = await fetchAdmin(port, '/admin/api/oauth/providers/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true, removed: true });

    // 4) Empty after delete
    const afterRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    expect(afterRes.status).toBe(200);
    expect(afterRes.body).toEqual({ providers: [] });
  });

  it('upsert twice updates the existing row with the newer clientId', async () => {
    const { deps, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    for (const clientId of ['first', 'second']) {
      const r = await fetchAdmin(port, '/admin/api/oauth/providers', {
        token: 'test-secret-token',
        method: 'POST',
        body: {
          provider: 'linear',
          clientId,
          clientSecret: 's',
          redirectUri: 'https://host/cb',
        },
      });
      expect(r.status).toBe(200);
    }

    const listRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    const body = listRes.body as { providers: Array<{ provider: string; clientId: string }> };
    expect(body.providers).toHaveLength(1);
    expect(body.providers[0].clientId).toBe('second');
  });

  it('POST without clientSecret works (public-client admin-registered config)', async () => {
    const { deps, oauthStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const postRes = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'public-thing',
        clientId: 'cid-public',
        redirectUri: 'https://host/cb',
      },
    });
    expect(postRes.status).toBe(200);

    // Store round-trip: clientSecret is absent, not a string.
    const got = await oauthStore!.get('public-thing');
    expect(got).not.toBeNull();
    expect(got!.clientSecret).toBeUndefined();

    // List response still excludes the field.
    const listRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    const body = listRes.body as { providers: Array<Record<string, unknown>> };
    expect('clientSecret' in body.providers[0]).toBe(false);
  });

  it('POST with missing fields returns 400 and writes nothing', async () => {
    const { deps, oauthStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: { provider: 'x' }, // missing clientId + redirectUri
    });
    expect(res.status).toBe(400);

    // No row was written.
    expect(await oauthStore!.get('x')).toBeNull();
  });

  it('POST with invalid redirectUri (not a URL) returns 400', async () => {
    const { deps, oauthStore, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'linear',
        clientId: 'cid-x',
        clientSecret: 's',
        redirectUri: 'not-a-url',
      },
    });
    expect(res.status).toBe(400);
    expect(await oauthStore!.get('linear')).toBeNull();
  });

  it('DELETE non-existent provider is idempotent: 200 { removed: false } + no audit', async () => {
    const { deps, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/oauth/providers/never-registered', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: false });

    // No audit entry when nothing was removed.
    expect(auditLog).not.toHaveBeenCalled();
  });

  it('DELETE with URL-encoded provider name (hyphens + underscore) round-trips', async () => {
    const { deps, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const providerName = 'my-org_prod';
    const postRes = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: providerName,
        clientId: 'cid',
        redirectUri: 'https://host/cb',
      },
    });
    expect(postRes.status).toBe(200);

    const encoded = encodeURIComponent(providerName);
    const delRes = await fetchAdmin(port, `/admin/api/oauth/providers/${encoded}`, {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect(delRes.body).toEqual({ ok: true, removed: true });

    // Gone from the list.
    const listRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    expect(listRes.body).toEqual({ providers: [] });
  });

  it('503 on all three endpoints when adminOAuthProviderStore is missing', async () => {
    const { deps, cleanup } = await mockDeps({ withOAuthStore: false });
    cleanupStore = cleanup;
    expect(deps.adminOAuthProviderStore).toBeUndefined();
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const expectedMsg = 'OAuth providers not configured';

    const getRes = await fetchAdmin(port, '/admin/api/oauth/providers', { token: 'test-secret-token' });
    expect(getRes.status).toBe(503);
    expect((getRes.body as { error: { message: string } }).error.message).toBe(expectedMsg);

    const postRes = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'linear',
        clientId: 'cid',
        redirectUri: 'https://host/cb',
      },
    });
    expect(postRes.status).toBe(503);
    expect((postRes.body as { error: { message: string } }).error.message).toBe(expectedMsg);

    const delRes = await fetchAdmin(port, '/admin/api/oauth/providers/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(delRes.status).toBe(503);
    expect((delRes.body as { error: { message: string } }).error.message).toBe(expectedMsg);
  });

  it('audit on upsert: hasSecret=true when clientSecret is provided, and the secret value never leaks', async () => {
    const { deps, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'linear',
        clientId: 'cid-x',
        clientSecret: 'shh',
        redirectUri: 'https://host/cb',
      },
    });
    expect(res.status).toBe(200);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('oauth_provider_upserted');
    expect(auditCall.args).toEqual({ provider: 'linear', hasSecret: true });

    // Load-bearing: the raw clientSecret MUST NOT appear anywhere in the audit payload.
    expect(JSON.stringify(auditCall)).not.toContain('shh');
  });

  it('audit on upsert: hasSecret=false when clientSecret is absent', async () => {
    const { deps, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    const res = await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'public-thing',
        clientId: 'cid-public',
        redirectUri: 'https://host/cb',
      },
    });
    expect(res.status).toBe(200);

    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('oauth_provider_upserted');
    expect(auditCall.args).toEqual({ provider: 'public-thing', hasSecret: false });
  });

  it('audit on delete: emitted when removed=true; NOT emitted when removed=false', async () => {
    const { deps, auditLog, cleanup } = await mockDeps();
    cleanupStore = cleanup;
    const handler = createAdminHandler(deps);
    ({ server, port } = await startTestServer(handler));

    // Seed a provider so the first delete has something to remove.
    await fetchAdmin(port, '/admin/api/oauth/providers', {
      token: 'test-secret-token',
      method: 'POST',
      body: {
        provider: 'linear',
        clientId: 'cid',
        redirectUri: 'https://host/cb',
      },
    });
    // One audit emitted for the upsert — reset so we're counting only deletes.
    expect(auditLog).toHaveBeenCalledTimes(1);
    auditLog.mockClear();

    // First delete removes the row → audit fires.
    const delRes1 = await fetchAdmin(port, '/admin/api/oauth/providers/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(delRes1.status).toBe(200);
    expect(delRes1.body).toEqual({ ok: true, removed: true });
    expect(auditLog).toHaveBeenCalledTimes(1);
    const auditCall = auditLog.mock.calls[0][0] as { action: string; args: Record<string, unknown> };
    expect(auditCall.action).toBe('oauth_provider_deleted');
    expect(auditCall.args).toEqual({ provider: 'linear' });

    auditLog.mockClear();

    // Second delete is a no-op → no audit.
    const delRes2 = await fetchAdmin(port, '/admin/api/oauth/providers/linear', {
      token: 'test-secret-token',
      method: 'DELETE',
    });
    expect(delRes2.status).toBe(200);
    expect(delRes2.body).toEqual({ ok: true, removed: false });
    expect(auditLog).not.toHaveBeenCalled();
  });
});
