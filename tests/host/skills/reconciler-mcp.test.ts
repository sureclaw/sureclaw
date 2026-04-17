import { describe, it, expect } from 'vitest';
import { computeMcpDesired } from '../../../src/host/skills/reconciler.js';
import type { SkillSnapshotEntry, SkillState } from '../../../src/host/skills/types.js';

const enabled = (name: string): SkillState => ({ name, kind: 'enabled', description: 'd' });

function skill(
  name: string,
  mcpServers: Array<{ name: string; url: string; credential?: string }> = [],
): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: 'd',
      credentials: [],
      mcpServers,
      domains: [],
    },
    body: '',
  } as SkillSnapshotEntry;
}

describe('computeMcpDesired', () => {
  it('registers MCP servers for enabled skills only', () => {
    const snapshot = [
      skill('a', [{ name: 'foo', url: 'https://mcp.foo.com' }]),
      skill('b', [{ name: 'bar', url: 'https://mcp.bar.com' }]),
    ];
    const states: SkillState[] = [enabled('a'), { name: 'b', kind: 'pending' }];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    expect(mcpServers.get('foo')?.url).toBe('https://mcp.foo.com');
    expect(mcpServers.has('bar')).toBe(false);
    expect(conflicts).toEqual([]);
  });

  it('reference-counts across skills — same name + same URL OK', () => {
    const snapshot = [
      skill('a', [{ name: 'shared', url: 'https://m.example' }]),
      skill('b', [{ name: 'shared', url: 'https://m.example' }]),
    ];
    const states: SkillState[] = [enabled('a'), enabled('b')];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    expect(mcpServers.size).toBe(1);
    expect(conflicts).toEqual([]);
  });

  it('flags a conflict when the same MCP name has different URLs', () => {
    const snapshot = [
      skill('a', [{ name: 'shared', url: 'https://one.example' }]),
      skill('b', [{ name: 'shared', url: 'https://two.example' }]),
    ];
    const states: SkillState[] = [enabled('a'), enabled('b')];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, states);
    // First occurrence wins; second skill is flagged.
    expect(mcpServers.get('shared')?.url).toBe('https://one.example');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ skillName: 'b', mcpName: 'shared' });
  });

  it('passes through bearerCredential when declared', () => {
    const snapshot = [
      skill('a', [{ name: 'foo', url: 'https://m.example', credential: 'FOO_TOKEN' }]),
    ];
    const { mcpServers } = computeMcpDesired(snapshot, [enabled('a')]);
    expect(mcpServers.get('foo')?.bearerCredential).toBe('FOO_TOKEN');
  });

  it('deduplicates duplicate MCP names within a single skill (no self-conflict)', () => {
    const snapshot = [
      skill('a', [
        { name: 'dup', url: 'https://first.example' },
        { name: 'dup', url: 'https://second.example' },
      ]),
    ];
    const { mcpServers, conflicts } = computeMcpDesired(snapshot, [enabled('a')]);
    expect(mcpServers.get('dup')?.url).toBe('https://first.example');
    expect(conflicts).toEqual([]);
  });
});
