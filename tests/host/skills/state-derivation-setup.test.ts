import { describe, it, expect } from 'vitest';
import { computeSetupQueue } from '../../../src/host/skills/state-derivation.js';
import type { SkillSnapshotEntry, SkillDerivationState } from '../../../src/host/skills/types.js';

const empty: Pick<SkillDerivationState, 'approvedDomains' | 'storedCredentials'> = {
  approvedDomains: new Set(),
  storedCredentials: new Set(),
};

describe('computeSetupQueue', () => {
  it('emits a setup request for a pending skill with missing credential + unapproved domain', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'Query Linear.',
          credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
          mcpServers: [{ name: 'linear', url: 'https://mcp.linear.app/sse' }],
          domains: ['api.linear.app'],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(queue[0].unapprovedDomains).toEqual(['api.linear.app']);
    expect(queue[0].mcpServers[0].url).toBe('https://mcp.linear.app/sse');
  });

  it('emits nothing for a skill whose requirements are all satisfied', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'x',
          credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
          mcpServers: [],
          domains: ['api.linear.app'],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, {
      approvedDomains: new Set(['linear/api.linear.app']),
      storedCredentials: new Set(['linear/LINEAR_TOKEN@user']),
    });
    expect(queue).toEqual([]);
  });

  it('emits a card for a re-added skill whose old rows still exist under a prior skillName', () => {
    // Regression: skill was deleted + re-added. Rows from the prior life
    // (or another skill with the same envName) do not satisfy the re-added
    // skill; a setup card is required so the admin re-blesses it.
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'x',
          credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
          mcpServers: [],
          domains: ['api.linear.app'],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, {
      // Rows exist, but under a different skill_name — do not satisfy 'linear'.
      approvedDomains: new Set(['github/api.linear.app']),
      storedCredentials: new Set(['github/LINEAR_TOKEN@user']),
    });
    expect(queue).toHaveLength(1);
    expect(queue[0].skillName).toBe('linear');
    expect(queue[0].missingCredentials[0].envName).toBe('LINEAR_TOKEN');
    expect(queue[0].unapprovedDomains).toEqual(['api.linear.app']);
  });

  it('carries OAuth block metadata through to the setup request', () => {
    const snapshot: SkillSnapshotEntry[] = [
      {
        name: 'linear',
        ok: true,
        frontmatter: {
          name: 'linear',
          description: 'x',
          credentials: [
            {
              envName: 'LINEAR_TOKEN',
              authType: 'oauth',
              scope: 'user',
              oauth: {
                provider: 'linear',
                clientId: 'pub_abc',
                authorizationUrl: 'https://linear.app/oauth/authorize',
                tokenUrl: 'https://api.linear.app/oauth/token',
                scopes: ['read'],
              },
            },
          ],
          mcpServers: [],
          domains: [],
        },
        body: '',
      },
    ];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue[0].missingCredentials[0].oauth?.provider).toBe('linear');
  });

  it('skips invalid snapshot entries', () => {
    const snapshot: SkillSnapshotEntry[] = [{ name: 'broken', ok: false, error: 'bad' }];
    const queue = computeSetupQueue(snapshot, empty);
    expect(queue).toEqual([]);
  });
});
