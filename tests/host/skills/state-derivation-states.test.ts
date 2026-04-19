import { describe, it, expect } from 'vitest';
import { computeSkillStates } from '../../../src/host/skills/state-derivation.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';

function skill(overrides: Partial<SkillSnapshotEntry> = {}): SkillSnapshotEntry {
  return {
    name: 'linear',
    ok: true,
    frontmatter: {
      name: 'linear',
      description: 'Query Linear.',
      credentials: [],
      mcpServers: [],
      domains: [],
    },
    body: '',
    ...overrides,
  } as SkillSnapshotEntry;
}

describe('computeSkillStates', () => {
  it('marks a skill with no requirements as enabled', () => {
    const states = computeSkillStates([skill()], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('enabled');
    expect(states[0].description).toBe('Query Linear.');
  });

  it('marks skill pending when a credential is missing', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('LINEAR_TOKEN'))).toBe(true);
  });

  it('marks skill enabled when credential is stored at the declared scope', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(['linear/LINEAR_TOKEN@user']),
    });
    expect(states[0].kind).toBe('enabled');
  });

  it('does not accept an agent-scoped credential as satisfying a user-scoped requirement', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(['linear/LINEAR_TOKEN@agent']),
    });
    expect(states[0].kind).toBe('pending');
  });

  it('does not accept a matching envName from a different skill as satisfying the requirement', () => {
    // Regression: deleting a skill and re-adding it (or adding a second skill
    // with the same envName) must not auto-enable via another skill's row.
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [],
        domains: [],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      // Row belongs to a different skill ('github') — must not satisfy 'linear'.
      storedCredentials: new Set(['github/LINEAR_TOKEN@user']),
    });
    expect(states[0].kind).toBe('pending');
  });

  it('does not accept a matching domain approved for a different skill', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [],
        mcpServers: [],
        domains: ['api.linear.app'],
      },
    });
    const states = computeSkillStates([s], {
      // Approval belongs to 'github', not 'linear'.
      approvedDomains: new Set(['github/api.linear.app']),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('pending');
  });

  it('marks skill pending when a domain is unapproved', () => {
    const s = skill({
      frontmatter: {
        name: 'linear',
        description: 'x',
        credentials: [],
        mcpServers: [],
        domains: ['api.linear.app'],
      },
    });
    const states = computeSkillStates([s], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('pending');
    expect(states[0].pendingReasons?.some((r) => r.includes('api.linear.app'))).toBe(true);
  });

  it('bubbles parse errors up as invalid', () => {
    const bad: SkillSnapshotEntry = { name: 'broken', ok: false, error: 'invalid YAML: x' };
    const states = computeSkillStates([bad], {
      approvedDomains: new Set(),
      storedCredentials: new Set(),
    });
    expect(states[0].kind).toBe('invalid');
    expect(states[0].error).toBe('invalid YAML: x');
  });
});
