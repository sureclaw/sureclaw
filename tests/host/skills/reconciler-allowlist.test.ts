import { describe, it, expect } from 'vitest';
import { computeProxyAllowlist } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry, SkillState } from '../../../src/host/skills/types.js';

const enabled = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });
const pending = (name: string): SkillState => ({ name, kind: 'pending', description: 'd' });

function skill(name: string, domains: string[] = []): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: 'd',
      credentials: [],
      mcpServers: [],
      domains,
    },
    body: '',
  } as SkillSnapshotEntry;
}

describe('computeProxyAllowlist', () => {
  it('is the union of domains of enabled skills (no filtering needed — approval already gated enable)', () => {
    const snapshot = [skill('a', ['api.foo']), skill('b', ['api.bar'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), enabled('b')]);
    expect([...allowed].sort()).toEqual(['api.bar', 'api.foo']);
  });

  it('excludes domains of pending skills', () => {
    const snapshot = [skill('a', ['api.foo']), skill('b', ['api.bar'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), pending('b')]);
    expect([...allowed]).toEqual(['api.foo']);
  });

  it('dedupes domains shared between enabled skills', () => {
    const snapshot = [skill('a', ['shared.com']), skill('b', ['shared.com'])];
    const allowed = computeProxyAllowlist(snapshot, [enabled('a'), enabled('b')]);
    expect([...allowed]).toEqual(['shared.com']);
  });
});
