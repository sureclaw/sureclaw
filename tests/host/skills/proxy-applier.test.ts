import { describe, it, expect, vi } from 'vitest';
import { ProxyDomainList } from '../../../src/host/proxy-domain-list.js';
import { createProxyApplier } from '../../../src/host/skills/proxy-applier.js';

function fakeAudit() {
  const entries: any[] = [];
  return { log: vi.fn(async (e: any) => { entries.push(e); }), query: vi.fn(), entries };
}

describe('ProxyApplier', () => {
  it('sets this agent\'s contribution on first apply', async () => {
    const list = new ProxyDomainList();
    const audit = fakeAudit();
    const applier = createProxyApplier({ proxyDomainList: list, audit });

    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual(['api.linear.app']);
    expect(result.removed).toEqual([]);
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      action: 'proxy_allowlist_updated',
      args: expect.objectContaining({ agentId: 'a1' }),
    }));
  });

  it('replaces the prior agent contribution (diffed add/remove)', async () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    await applier.apply('a1', new Set(['api.linear.app', 'slack.com']));
    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['slack.com']);
    expect(list.isAllowed('slack.com')).toBe(false);
    expect(list.isAllowed('api.linear.app')).toBe(true);
  });

  it('no-op when desired equals current', async () => {
    const list = new ProxyDomainList();
    const audit = fakeAudit();
    const applier = createProxyApplier({ proxyDomainList: list, audit });

    await applier.apply('a1', new Set(['api.linear.app']));
    audit.log.mockClear();
    const result = await applier.apply('a1', new Set(['api.linear.app']));

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('clears agent when desired is empty', async () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    await applier.apply('a1', new Set(['api.linear.app']));
    const result = await applier.apply('a1', new Set());

    expect(result.added).toEqual([]);
    expect(result.removed).toEqual(['api.linear.app']);
    expect(list.isAllowed('api.linear.app')).toBe(false);
  });

  it('removeAgent drops the agent contribution and resets the prior baseline', async () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    await applier.apply('a1', new Set(['api.linear.app']));
    applier.removeAgent('a1');

    // Contribution dropped from the allowlist.
    expect(list.isAllowed('api.linear.app')).toBe(false);

    // Next apply treats the agent as fresh: the domain should reappear as
    // `added` (not seen as already-present from the stale prior).
    const result = await applier.apply('a1', new Set(['api.linear.app']));
    expect(result.added).toEqual(['api.linear.app']);
    expect(result.removed).toEqual([]);
  });

  it('removeAgent is a no-op for unknown agents', () => {
    const list = new ProxyDomainList();
    const applier = createProxyApplier({ proxyDomainList: list });

    expect(() => applier.removeAgent('never-seen')).not.toThrow();
  });
});
