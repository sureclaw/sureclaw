// tests/host/server-oauth-callback.test.ts
//
// Phase 6 Task 4 — HTTP-level coverage for /v1/oauth/callback/:provider.
//
// The callback handler tries the admin-initiated flow first (if wired) and
// falls through to the agent-initiated oauth-skills path when the admin
// flow returns { matched: false }. These tests spin up a real HTTP server
// around the createRequestHandler dispatcher with ONLY the deps the
// callback branch touches — credentials, audit, adminOAuthFlow,
// snapshotCache, eventBus. Everything else is cast/mocked: the callback
// branch exits early, and the rest never runs.
//
// Unit coverage for resolveCallback's full behavior lives in
// admin-oauth-flow.test.ts; this file only verifies the request-handler
// wiring (admin-wins + fall-through + error HTML).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  createRequestHandler,
  type RequestHandlerOpts,
} from '../../src/host/server-request-handlers.js';
import { createAdminOAuthFlow } from '../../src/host/admin-oauth-flow.js';
import type { CredentialProvider } from '../../src/providers/credentials/types.js';
import type { AuditProvider } from '../../src/providers/audit/types.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

function makeCredentials(): CredentialProvider {
  return {
    async get() { return null; },
    async set() { /* noop */ },
    async delete() { /* noop */ },
    async list() { return []; },
  };
}

function makeAudit(): AuditProvider {
  return {
    async log() { /* noop */ },
    async query() { return []; },
  };
}

function makeSkillCredStore() {
  return {
    async put() { /* noop */ },
    async get() { return null; },
    async listForAgent() { return []; },
    async listEnvNames() { return new Set<string>(); },
  };
}

function makeSnapshotCache() {
  return {
    get() { return undefined; },
    put() { /* noop */ },
    invalidateAgent() { return 0; },
    clear() { /* noop */ },
    size() { return 0; },
  };
}

function mockFetchResponse(status: number, body: unknown): Response {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return bodyStr; },
    async json() { return typeof body === 'string' ? JSON.parse(body) : body; },
  } as unknown as Response;
}

function buildRequestOpts(extra: Partial<RequestHandlerOpts>): RequestHandlerOpts {
  // The callback branch touches: providers.credentials, providers.audit,
  // eventBus (for fall-through), adminOAuthFlow, snapshotCache. Everything
  // else is a type-shape filler — casts are acceptable because the branch
  // returns before any of those fields are dereferenced.
  return {
    modelId: 'test-model',
    agentName: 'test-agent',
    adminCtx: {} as RequestHandlerOpts['adminCtx'],
    eventBus: {} as RequestHandlerOpts['eventBus'],
    providers: {
      credentials: makeCredentials(),
      audit: makeAudit(),
    } as unknown as RequestHandlerOpts['providers'],
    fileStore: {} as RequestHandlerOpts['fileStore'],
    taintBudget: {} as RequestHandlerOpts['taintBudget'],
    completionOpts: {} as RequestHandlerOpts['completionOpts'],
    webhookPrefix: '/webhooks/',
    webhookHandler: null,
    adminHandler: null,
    isDraining: () => false,
    ...extra,
  };
}

async function withServer(opts: RequestHandlerOpts): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  const handler = createRequestHandler(opts);
  const server = createHttpServer((req, res) => { void handler(req, res); });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe('/v1/oauth/callback/:provider', () => {
  // The test issues its OWN fetch() requests to the local server, so we can't
  // just stubGlobal(fetch) — that would intercept test-side requests too.
  // Instead we intercept per-hostname: the real fetch handles 127.0.0.1,
  // and any OAuth token endpoint gets a mocked Response.
  const realFetch = globalThis.fetch.bind(globalThis);
  let tokenFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tokenFetch = vi.fn();
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (urlStr.startsWith('http://127.0.0.1:') || urlStr.startsWith('http://localhost:')) {
        return realFetch(input as Parameters<typeof realFetch>[0], init);
      }
      return tokenFetch(urlStr, init);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('admin-wins: matching admin state yields 200 success HTML', async () => {
    const adminOAuthFlow = createAdminOAuthFlow();
    const { state } = adminOAuthFlow.start({
      agentId: 'main',
      agentName: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      scope: 'user',
      userId: 'alice',
      provider: 'linear',
      authorizationUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      clientId: 'frontmatter-cid',
      scopes: ['read'],
      redirectUri: 'http://127.0.0.1/v1/oauth/callback/linear',
    });

    tokenFetch.mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at-http', refresh_token: 'rt-http' }),
    );

    const harness = await withServer(buildRequestOpts({
      adminOAuthFlow,
      skillCredStore: makeSkillCredStore(),
      snapshotCache: makeSnapshotCache(),
    }));

    try {
      const url = `${harness.url}/v1/oauth/callback/linear?code=code-x&state=${encodeURIComponent(state)}`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('Authentication successful');
      expect(body).toContain('dashboard');
    } finally {
      await harness.close();
    }
  });

  it('admin matched-but-failed (provider mismatch) → 400 with friendly reason HTML, no fall-through', async () => {
    const adminOAuthFlow = createAdminOAuthFlow();
    const { state } = adminOAuthFlow.start({
      agentId: 'main',
      agentName: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      scope: 'user',
      userId: 'alice',
      provider: 'linear',
      authorizationUrl: 'https://linear.app/oauth/authorize',
      tokenUrl: 'https://api.linear.app/oauth/token',
      clientId: 'cid',
      scopes: ['read'],
      redirectUri: 'http://127.0.0.1/v1/oauth/callback/linear',
    });

    const harness = await withServer(buildRequestOpts({
      adminOAuthFlow,
      skillCredStore: makeSkillCredStore(),
    }));

    try {
      // Mismatched provider in URL — state is admin's, should be claimed + fail.
      const url = `${harness.url}/v1/oauth/callback/evil?code=x&state=${encodeURIComponent(state)}`;
      const res = await fetch(url);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Authentication failed');
      // The `invalid_response` reason maps to a friendly message per
      // OAUTH_CALLBACK_HTML — no raw enum identifier in the response
      // body, but a distinguishing substring still pins the branch.
      expect(body).toContain("didn't look right");
      // No token exchange happened — we refused the path mismatch.
      expect(tokenFetch).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it('fall-through: unknown state passes to agent-initiated handler (which rejects)', async () => {
    const adminOAuthFlow = createAdminOAuthFlow();
    // No admin flow started — any state is unknown to admin.

    const harness = await withServer(buildRequestOpts({
      adminOAuthFlow,
      skillCredStore: makeSkillCredStore(),
    }));

    try {
      const url = `${harness.url}/v1/oauth/callback/linear?code=x&state=not-admin-state`;
      const res = await fetch(url);
      // oauth-skills.ts's resolveOAuthCallback returns false for unknown
      // state → handler returns 400 "Authentication failed".
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Authentication failed');
    } finally {
      await harness.close();
    }
  });

  it('missing code/state → 400 "Bad request" HTML', async () => {
    const adminOAuthFlow = createAdminOAuthFlow();
    const harness = await withServer(buildRequestOpts({
      adminOAuthFlow,
      skillCredStore: makeSkillCredStore(),
    }));

    try {
      const res = await fetch(`${harness.url}/v1/oauth/callback/linear`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Bad request');
    } finally {
      await harness.close();
    }
  });
});
