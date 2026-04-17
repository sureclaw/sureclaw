import { describe, test, expect } from 'vitest';
import { ProxyDomainList } from '../../src/host/proxy-domain-list.js';
import { parseAgentSkill } from '../../src/utils/skill-format-parser.js';
import { generateManifest } from '../../src/utils/manifest-generator.js';

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

  test('setAgentDomains stores and merges per-agent contributions', () => {
    const list = new ProxyDomainList();
    list.setAgentDomains('a1', ['api.linear.app']);
    list.setAgentDomains('a2', ['slack.com']);
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(list.isAllowed('slack.com')).toBe(true);
  });

  test('setAgentDomains replaces (does not merge) prior value for same agent', () => {
    const list = new ProxyDomainList();
    list.setAgentDomains('a1', ['api.linear.app', 'example.com']);
    list.setAgentDomains('a1', ['api.linear.app']); // drop example.com
    expect(list.isAllowed('api.linear.app')).toBe(true);
    expect(list.isAllowed('example.com')).toBe(false);
  });

  test('setAgentDomains with empty array clears that agent and does not affect others', () => {
    const list = new ProxyDomainList();
    list.setAgentDomains('a1', ['example.com']);
    list.setAgentDomains('a2', ['slack.com']);
    list.setAgentDomains('a1', []);
    expect(list.isAllowed('example.com')).toBe(false);
    expect(list.isAllowed('slack.com')).toBe(true);
  });

  test('setAgentDomains does not drop skill-keyed or admin-approved entries', () => {
    const list = new ProxyDomainList();
    list.addSkillDomains('old-skill', ['legacy.example']);
    list.approvePending('admin.example');
    list.setAgentDomains('a1', ['api.linear.app']);
    expect(list.isAllowed('legacy.example')).toBe(true);
    expect(list.isAllowed('admin.example')).toBe(true);
    expect(list.isAllowed('api.linear.app')).toBe(true);
  });

  test('setAgentDomains normalizes (trim + lowercase + strip trailing dot)', () => {
    const list = new ProxyDomainList();
    list.setAgentDomains('a1', ['  API.LINEAR.APP.  ']);
    expect(list.isAllowed('api.linear.app')).toBe(true);
  });

  test('domains extracted from DB-stored skill instructions are allowed after reload', () => {
    // Simulates the host restart path: skill stored in DB as JSON, parsed on
    // startup, domains re-extracted from SKILL.md instructions via manifest generator.
    const skillInstructions = [
      '---',
      'name: linear',
      'description: Query Linear issues',
      'metadata: {"clawdis":{"requires":{"env":["LINEAR_API_KEY"]}}}',
      '---',
      '',
      '# Linear',
      '',
      '```bash',
      'curl -X POST https://api.linear.app/graphql \\',
      '  -H "Authorization: $LINEAR_API_KEY"',
      '```',
    ].join('\n');

    const parsed = parseAgentSkill(skillInstructions);
    const manifest = generateManifest(parsed);

    const list = new ProxyDomainList();
    if (manifest.capabilities.domains.length > 0) {
      list.addSkillDomains(parsed.name || 'linear', manifest.capabilities.domains);
    }

    expect(list.isAllowed('api.linear.app')).toBe(true);
  });
});
