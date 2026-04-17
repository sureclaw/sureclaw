// tests/host/admin-oauth-flow.test.ts — unit tests for the in-memory
// admin-initiated OAuth pending-flow map (Phase 6 Task 3).

import { describe, it, expect } from 'vitest';
import { createAdminOAuthFlow, type StartFlowInput } from '../../src/host/admin-oauth-flow.js';
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
