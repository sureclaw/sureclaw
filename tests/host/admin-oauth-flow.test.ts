// tests/host/admin-oauth-flow.test.ts — unit tests for the in-memory
// admin-initiated OAuth pending-flow map (Phase 6 Task 3) + resolveCallback
// (Phase 6 Task 4).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAdminOAuthFlow, type StartFlowInput } from '../../src/host/admin-oauth-flow.js';
import type { AuditProvider } from '../../src/providers/audit/types.js';
import { initLogger } from '../../src/logger.js';

initLogger({ file: false, level: 'silent' });

function baseInput(overrides: Partial<StartFlowInput> = {}): StartFlowInput {
  return {
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
    scopes: ['read', 'write'],
    redirectUri: 'https://host.example/v1/oauth/callback/linear',
    ...overrides,
  };
}

describe('createAdminOAuthFlow', () => {
  it('start returns {state, authUrl} with all required OAuth params', () => {
    const flow = createAdminOAuthFlow();
    const { state, authUrl } = flow.start(baseInput());

    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);

    const url = new URL(authUrl);
    expect(url.origin + url.pathname).toBe('https://linear.app/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('frontmatter-cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://host.example/v1/oauth/callback/linear');
    expect(url.searchParams.get('scope')).toBe('read write');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');

    const challenge = url.searchParams.get('code_challenge');
    expect(challenge).not.toBeNull();
    expect(challenge!.length).toBeGreaterThan(0);

    expect(url.searchParams.get('state')).toBe(state);
  });

  it('uses admin override clientId (NOT frontmatter) when provided', () => {
    const flow = createAdminOAuthFlow();
    const { authUrl } = flow.start(baseInput({
      adminOverride: { clientId: 'admin-cid', clientSecret: 'admin-shh' },
    }));
    const url = new URL(authUrl);
    expect(url.searchParams.get('client_id')).toBe('admin-cid');
    // Frontmatter value must not sneak through.
    expect(authUrl).not.toContain('frontmatter-cid');
  });

  it('stores clientSecret only when admin override provides one', () => {
    const flow = createAdminOAuthFlow();

    // With secret.
    const r1 = flow.start(baseInput({
      adminOverride: { clientId: 'admin-cid', clientSecret: 'admin-shh' },
    }));
    const stored1 = flow.claim(r1.state);
    expect(stored1).toBeDefined();
    expect(stored1!.clientSecret).toBe('admin-shh');
    expect(stored1!.clientId).toBe('admin-cid');

    // Without secret (public-client admin override).
    const r2 = flow.start(baseInput({
      adminOverride: { clientId: 'admin-cid-public' },
    }));
    const stored2 = flow.claim(r2.state);
    expect(stored2).toBeDefined();
    expect(stored2!.clientSecret).toBeUndefined();
    expect(stored2!.clientId).toBe('admin-cid-public');

    // No adminOverride at all → no secret, frontmatter clientId wins.
    const r3 = flow.start(baseInput());
    const stored3 = flow.claim(r3.state);
    expect(stored3).toBeDefined();
    expect(stored3!.clientSecret).toBeUndefined();
    expect(stored3!.clientId).toBe('frontmatter-cid');
  });

  it('claim is single-use: returns the flow once, undefined on replay', () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    const first = flow.claim(state);
    expect(first).toBeDefined();
    expect(first!.skillName).toBe('linear-tracker');
    expect(first!.envName).toBe('LINEAR_TOKEN');

    const replay = flow.claim(state);
    expect(replay).toBeUndefined();
  });

  it('claim on unknown state returns undefined', () => {
    const flow = createAdminOAuthFlow();
    expect(flow.claim('not-a-real-state')).toBeUndefined();
  });

  it('TTL expiry: claim returns undefined after 15 minutes', () => {
    let t = 1_000_000_000_000;
    const flow = createAdminOAuthFlow({ now: () => t });
    const { state } = flow.start(baseInput());

    // Advance clock to just past 15 minutes.
    t += 15 * 60 * 1000 + 1;
    expect(flow.claim(state)).toBeUndefined();
  });

  it('TTL sweep on start: expired entries are removed when a new flow starts', () => {
    let t = 1_000_000_000_000;
    const flow = createAdminOAuthFlow({ now: () => t });

    // Start three flows at t0.
    flow.start(baseInput({ skillName: 'a' }));
    flow.start(baseInput({ skillName: 'b' }));
    flow.start(baseInput({ skillName: 'c' }));
    expect(flow.size()).toBe(3);

    // Advance past TTL; a new start should sweep the old three, leaving only
    // the newly-started one.
    t += 15 * 60 * 1000 + 1;
    flow.start(baseInput({ skillName: 'd' }));
    expect(flow.size()).toBe(1);
  });

  it('size reflects non-expired entries only', () => {
    let t = 1_000_000_000_000;
    const flow = createAdminOAuthFlow({ now: () => t });
    flow.start(baseInput({ skillName: 'a' }));
    flow.start(baseInput({ skillName: 'b' }));
    expect(flow.size()).toBe(2);

    t += 15 * 60 * 1000 + 1;
    expect(flow.size()).toBe(0);
  });

  it('empty scopes array yields scope= (empty) param', () => {
    const flow = createAdminOAuthFlow();
    const { authUrl } = flow.start(baseInput({ scopes: [] }));
    const url = new URL(authUrl);
    // URLSearchParams renders scope= when the value is the empty string.
    expect(url.searchParams.get('scope')).toBe('');
  });
});

// ──────────────────────────────────────────────────────────────────────
// Phase 6 Task 4: resolveCallback — token exchange + credential write +
// reconcile.  Every test below stubs global.fetch (restored in afterEach)
// and asserts the credential-store + audit call shape.  The audit/call
// transcripts are substring-guarded against literal token values, which is
// the cheapest practical check that tokens never leak into logs or args.
// ──────────────────────────────────────────────────────────────────────

function makeAudit(): AuditProvider & { calls: Array<Partial<import('../../src/providers/audit/types.js').AuditEntry>> } {
  const calls: Array<Partial<import('../../src/providers/audit/types.js').AuditEntry>> = [];
  return {
    calls,
    async log(entry) { calls.push(entry); },
    async query() { return []; },
  };
}

interface SkillCredPutCall {
  agentId: string;
  skillName: string;
  envName: string;
  userId: string;
  value: string;
}

function makeSkillCredStore(): {
  put(input: SkillCredPutCall): Promise<void>;
  get(): Promise<null>;
  listForAgent(): Promise<[]>;
  listEnvNames(): Promise<Set<string>>;
  putCalls: SkillCredPutCall[];
} {
  const putCalls: SkillCredPutCall[] = [];
  return {
    putCalls,
    async put(input) { putCalls.push(input); },
    async get() { return null; },
    async listForAgent() { return []; },
    async listEnvNames() { return new Set(); },
  };
}

function makeSnapshotCache(): {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  invalidateAgent: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
  size: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn(),
    put: vi.fn(),
    invalidateAgent: vi.fn().mockReturnValue(0),
    clear: vi.fn(),
    size: vi.fn().mockReturnValue(0),
  };
}

function mockFetchResponse(status: number, body: unknown): Response {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return bodyStr; },
    async json() {
      if (typeof body === 'string') throw new Error('invalid json');
      return body;
    },
  } as unknown as Response;
}

describe('resolveCallback', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('happy path — PKCE public client writes access_token + refresh blob + audit + reconcile', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at-123', refresh_token: 'rt-456', expires_in: 3600 }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();
    const snapshotCache = makeSnapshotCache();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code-x',
      state,
      skillCredStore,
      audit,
      snapshotCache,
    });

    expect(result).toEqual({ matched: true, ok: true });

    // Tuple-keyed write: access_token lands in skill_credentials at
    // (agentId, skillName, envName, userId). Refresh blob lands under a
    // sibling envName in the same tuple row.
    const tokenPut = skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN');
    expect(tokenPut).toEqual({
      agentId: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      userId: 'alice',
      value: 'at-123',
    });
    const blobPut = skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN__oauth_blob');
    expect(blobPut).toBeDefined();
    expect(blobPut!.agentId).toBe('main');
    expect(blobPut!.skillName).toBe('linear-tracker');
    expect(blobPut!.userId).toBe('alice');
    const blob = JSON.parse(blobPut!.value);
    expect(blob.access_token).toBe('at-123');
    expect(blob.refresh_token).toBe('rt-456');
    expect(blob.token_url).toBe('https://api.linear.app/oauth/token');
    expect(blob.client_id).toBe('frontmatter-cid');
    expect(blob.scopes).toEqual(['read', 'write']);

    // Audit success, hasRefreshToken:true, no token values.
    const success = audit.calls.find(c => c.action === 'oauth_callback_success');
    expect(success).toBeDefined();
    expect(success!.sessionId).toBe('main');
    expect(success!.args).toMatchObject({
      agentId: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      provider: 'linear',
      hasRefreshToken: true,
    });
    const auditText = JSON.stringify(audit.calls);
    expect(auditText).not.toContain('at-123');
    expect(auditText).not.toContain('rt-456');

    // Snapshot cache invalidated for this agent so the next live read is fresh.
    expect(snapshotCache.invalidateAgent).toHaveBeenCalledWith('main');

    // Token request body — no client_secret (PKCE public client).
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('code=code-x');
    expect(body).toContain('code_verifier=');
    expect(body).toContain('client_id=frontmatter-cid');
    expect(body).not.toContain('client_secret');
  });

  it('admin-registered (confidential) flow — client_secret IS in token body, never in audit', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput({
      adminOverride: { clientId: 'cid', clientSecret: 'shh' },
    }));

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at-z', refresh_token: 'rt-y', expires_in: 1800 }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code-conf',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: true });

    // client_secret in the form body.
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = fetchCall[1].body as string;
    expect(body).toContain('client_secret=shh');
    expect(body).toContain('client_id=cid');

    // Secret must not appear in audit.
    expect(JSON.stringify(audit.calls)).not.toContain('shh');

    // blob stores clientId but NOT the secret.
    const blobPut = skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN__oauth_blob');
    expect(blobPut).toBeDefined();
    const blob = JSON.parse(blobPut!.value);
    expect(blob.client_id).toBe('cid');
    expect(JSON.stringify(blob)).not.toContain('shh');
  });

  it('agent-scope flow writes skill_credentials row with user_id = "" sentinel', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput({ scope: 'agent', userId: undefined }));

    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'shared-tok' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code-agent',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: true });

    // Tuple write uses `user_id: ''` as the agent-scope sentinel.
    const tokenPut = skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN');
    expect(tokenPut).toEqual({
      agentId: 'main',
      skillName: 'linear-tracker',
      envName: 'LINEAR_TOKEN',
      userId: '',
      value: 'shared-tok',
    });
  });

  it('unknown state → {matched:false}, no fetch call', async () => {
    const flow = createAdminOAuthFlow();
    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state: 'not-a-real-state',
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(skillCredStore.putCalls).toEqual([]);
    expect(audit.calls).toEqual([]);
  });

  it('provider mismatch → matched:true, ok:false, invalid_response, no fetch, no cred write', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput()); // provider = 'linear'
    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'evil',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({
      matched: true,
      ok: false,
      reason: 'invalid_response',
      details: 'provider mismatch',
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(skillCredStore.putCalls).toEqual([]);

    // Audit failure emitted so mismatches are visible.
    const fail = audit.calls.find(c => c.action === 'oauth_callback_failed');
    expect(fail).toBeDefined();
    expect((fail!.args as { reason?: string }).reason).toBe('provider_mismatch');
  });

  it('token exchange 400 → {matched:true, ok:false, reason:token_exchange_failed}, no cred write', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(400, 'invalid_grant'),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: false, reason: 'token_exchange_failed' });
    expect(skillCredStore.putCalls).toEqual([]);

    const fail = audit.calls.find(c => c.action === 'oauth_callback_failed');
    expect(fail).toBeDefined();
    expect((fail!.args as { status?: number }).status).toBe(400);
  });

  it('response missing access_token → {matched:true, ok:false, reason:invalid_response}, no cred write', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { error: 'wat' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result.matched).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'invalid_response' });
    expect(skillCredStore.putCalls).toEqual([]);

    const fail = audit.calls.find(c => c.action === 'oauth_callback_failed');
    expect(fail).toBeDefined();
  });

  it('no refresh_token → access_token still written, no blob, hasRefreshToken:false', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at-only' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: true });
    expect(skillCredStore.putCalls).toHaveLength(1);
    expect(skillCredStore.putCalls[0].envName).toBe('LINEAR_TOKEN');
    expect(skillCredStore.putCalls[0].value).toBe('at-only');
    expect(skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN__oauth_blob')).toBeUndefined();

    const success = audit.calls.find(c => c.action === 'oauth_callback_success');
    expect(success).toBeDefined();
    expect((success!.args as { hasRefreshToken?: boolean }).hasRefreshToken).toBe(false);
  });

  it('no snapshotCache dep → succeeds without calling invalidate', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: true });
    expect(skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN')).toBeDefined();
  });

  it('agent-scoped credential → written with userId = "" sentinel', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput({ scope: 'agent', userId: undefined }));
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at', refresh_token: 'rt' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code',
      state,
      skillCredStore,
      audit,
    });

    expect(result).toEqual({ matched: true, ok: true });
    const tokenPut = skillCredStore.putCalls.find(c => c.envName === 'LINEAR_TOKEN');
    expect(tokenPut).toBeDefined();
    expect(tokenPut!.userId).toBe('');
  });

  it('returns error when token endpoint hangs (AbortSignal.timeout fires)', async () => {
    // Short timeout (50ms) so the test doesn't wait 15s. The
    // `tokenExchangeTimeoutMs` knob on `createAdminOAuthFlow` exists purely
    // to keep this hygiene test fast — production default is 15s.
    const flow = createAdminOAuthFlow({ tokenExchangeTimeoutMs: 50 });
    const { state } = flow.start(baseInput());

    // Fetch returns a promise that only settles when its AbortSignal fires.
    // When the timeout expires, the runtime aborts the signal and we reject
    // with an AbortError — same shape a real fetch abort produces.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();
    const snapshotCache = makeSnapshotCache();

    const result = await flow.resolveCallback({
      provider: 'linear',
      code: 'code-hang',
      state,
      skillCredStore,
      audit,
      snapshotCache,
    });

    expect(result.matched).toBe(true);
    expect(result).toMatchObject({ ok: false, reason: 'error' });

    // No credential write, no cache invalidation — the hang must not leave
    // partial state behind.
    expect(skillCredStore.putCalls).toEqual([]);
    expect(snapshotCache.invalidateAgent).not.toHaveBeenCalled();

    // Audit records the failure so the DoS attempt is visible.
    const fail = audit.calls.find(c => c.action === 'oauth_callback_failed');
    expect(fail).toBeDefined();

    // Verify the signal was actually passed (not just that fetch was called).
    const fetchCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(fetchCall[1].signal).toBeInstanceOf(AbortSignal);
  });

  it('claim is single-use for callback: second resolveCallback with same state → matched:false', async () => {
    const flow = createAdminOAuthFlow();
    const { state } = flow.start(baseInput());
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      mockFetchResponse(200, { access_token: 'at' }),
    );

    const skillCredStore = makeSkillCredStore();
    const audit = makeAudit();

    const first = await flow.resolveCallback({
      provider: 'linear', code: 'c1', state, skillCredStore, audit,
    });
    expect(first).toEqual({ matched: true, ok: true });

    const second = await flow.resolveCallback({
      provider: 'linear', code: 'c2', state, skillCredStore, audit,
    });
    expect(second).toEqual({ matched: false });
    // Only one fetch — the second call short-circuited.
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });
});
