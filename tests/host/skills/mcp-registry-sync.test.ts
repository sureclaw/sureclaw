import { describe, it, expect } from 'vitest';
import { registerMcpServersFromSnapshot } from '../../../src/host/skills/mcp-registry-sync.js';
import { McpConnectionManager } from '../../../src/plugins/mcp-manager.js';
import type { SkillSnapshotEntry } from '../../../src/host/skills/types.js';

function ok(
  name: string,
  mcpServers: Array<{ name: string; url: string }>,
): SkillSnapshotEntry {
  return {
    name,
    ok: true,
    frontmatter: {
      name,
      description: `${name} skill`,
      credentials: [],
      mcpServers,
      domains: [],
    },
    body: '',
  };
}

describe('registerMcpServersFromSnapshot', () => {
  it('registers every mcpServer declared by every ok entry', () => {
    const mgr = new McpConnectionManager();
    const snapshot: SkillSnapshotEntry[] = [
      ok('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse' }]),
      ok('github', [{ name: 'github', url: 'https://api.github.com/mcp' }]),
    ];

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    const names = mgr.listServers('agent-1').map(s => s.name).sort();
    expect(names).toEqual(['github', 'linear']);
    expect(mgr.getServerMeta('agent-1', 'linear')).toMatchObject({ source: 'skill' });
  });

  it('is idempotent — calling twice leaves one entry per name', () => {
    const mgr = new McpConnectionManager();
    const snapshot = [ok('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse' }])];

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);
    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    expect(mgr.listServers('agent-1')).toHaveLength(1);
  });

  it('skips invalid entries (ok: false)', () => {
    const mgr = new McpConnectionManager();
    const snapshot: SkillSnapshotEntry[] = [
      { name: 'broken', ok: false, error: 'invalid frontmatter' },
      ok('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse' }]),
    ];

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    expect(mgr.listServers('agent-1').map(s => s.name)).toEqual(['linear']);
  });

  it('handles entries that declare zero mcpServers', () => {
    const mgr = new McpConnectionManager();
    const snapshot = [ok('weather', [])]; // no servers

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    expect(mgr.listServers('agent-1')).toEqual([]);
  });

  it('registers multiple servers from a single skill', () => {
    const mgr = new McpConnectionManager();
    const snapshot = [ok('multi', [
      { name: 'srv-a', url: 'https://a.example/mcp' },
      { name: 'srv-b', url: 'https://b.example/mcp' },
    ])];

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    expect(mgr.listServers('agent-1').map(s => s.name).sort()).toEqual(['srv-a', 'srv-b']);
  });

  it('tags registered servers with source:skill for later filtering', () => {
    const mgr = new McpConnectionManager();
    const snapshot = [ok('linear', [{ name: 'linear', url: 'https://mcp.linear.app/sse' }])];

    registerMcpServersFromSnapshot('agent-1', snapshot, mgr);

    expect(mgr.getServerMeta('agent-1', 'linear')?.source).toBe('skill');
  });
});
