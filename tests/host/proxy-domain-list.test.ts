import { describe, test, expect } from 'vitest';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';

describe('ProxyDomainList', () => {
  test('built-in domains are always allowed', () => {
    const list = new ProxyDomainList();
    expect(list.isAllowed('registry.npmjs.org')).toBe(true);
    expect(list.isAllowed('pypi.org')).toBe(true);
  });

  test('unknown domains are not allowed', () => {
    const list = new ProxyDomainList();
    expect(list.isAllowed('evil.com')).toBe(false);
  });

  test('addSkillDomains adds domains to allowlist', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app', 'api.github.com']);
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(list.isAllowed('api.github.com')).toBe(true);
  });

  test('removeSkillDomains removes only that skill domains', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('skill-a', ['api.example.com']);
    list.addSkillDomains('skill-b', ['api.example.com', 'api.other.com']);
    list.removeSkillDomains('skill-a');
    expect(list.isAllowed('api.example.com')).toBe(true);
    expect(list.isAllowed('api.other.com')).toBe(true);
    list.removeSkillDomains('skill-b');
    expect(list.isAllowed('api.example.com')).toBe(false);
  });

  test('addPending queues a denied domain', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    const pending = list.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ domain: 'api.evil.com', sessionId: 'session-1' });
  });

  test('approvePending moves domain to allowlist', () => {
    const list = new ProxyDomainList();
    list.addPending('api.newservice.com', 'session-1');
    expect(list.isAllowed('api.newservice.com')).toBe(false);
    list.approvePending('api.newservice.com');
    expect(list.isAllowed('api.newservice.com')).toBe(true);
    expect(list.getPending()).toHaveLength(0);
  });

  test('denyPending removes from pending without allowing', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    list.denyPending('api.evil.com');
    expect(list.isAllowed('api.evil.com')).toBe(false);
    expect(list.getPending()).toHaveLength(0);
  });

  test('addPending deduplicates same domain', () => {
    const list = new ProxyDomainList();
    list.addPending('api.evil.com', 'session-1');
    list.addPending('api.evil.com', 'session-2');
    expect(list.getPending()).toHaveLength(1);
  });

  test('allowed domains are not added to pending', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app']);
    list.addPending('api.linear.app', 'session-1');
    expect(list.getPending()).toHaveLength(0);
  });

  test('getAllowedDomains returns full set for proxy', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('my-skill', ['api.linear.app']);
    const allowed = list.getAllowedDomains();
    expect(allowed.has('api.linear.app')).toBe(true);
    expect(allowed.has('registry.npmjs.org')).toBe(true);
  });
});
