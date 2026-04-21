import { describe, test, expect, vi } from 'vitest';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import { populateCatalogFromSkills } from '../../../src/host/skills/catalog-population.js';

describe('populateCatalogFromSkills', () => {
  test('populates catalog from skill snapshot MCP servers', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', description: 'List', inputSchema: { type: 'object' } },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear' }] } } as never],
      getMcpClient: () => mcpClient as never,
      catalog,
    });
    expect(catalog.list()).toHaveLength(1);
    expect(catalog.get('mcp_linear_list_issues')).toBeDefined();
  });

  test('applies include filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', include: ['list_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('applies exclude filter from frontmatter', async () => {
    const mcpClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'list_issues', inputSchema: {} },
        { name: 'delete_issue', inputSchema: {} },
      ]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [{ name: 'linear', frontmatter: { mcpServers: [{ name: 'linear', exclude: ['delete_*'] }] } } as never],
      getMcpClient: () => mcpClient as never,
      catalog,
    });
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('skips entries with ok: false and servers where listTools throws', async () => {
    const goodClient = {
      listTools: vi.fn().mockResolvedValue([
        { name: 'ping', inputSchema: {} },
      ]),
    };
    const badClient = {
      listTools: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'broken', ok: false, error: 'invalid' } as never,
        {
          name: 'mixed',
          ok: true,
          frontmatter: {
            mcpServers: [
              { name: 'good-server' },
              { name: 'bad-server' },
            ],
          },
        } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'good-server' ? goodClient : badClient) as never,
      catalog,
    });
    // Only the good server contributed tools; bad server's failure is swallowed.
    expect(catalog.list().map(t => t.name)).toEqual(['mcp_mixed_ping']);
  });

  test('populates multiple skills and servers without cross-contamination', async () => {
    const linearClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const githubClient = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_repos', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
        { name: 'github', ok: true, frontmatter: { mcpServers: [{ name: 'github' }] } } as never,
      ],
      getMcpClient: (_skill, serverName) => (serverName === 'linear' ? linearClient : githubClient) as never,
      catalog,
    });
    expect(catalog.list().map(t => t.name).sort()).toEqual([
      'mcp_github_list_repos',
      'mcp_linear_list_issues',
    ]);
  });

  test('skips entries with no mcpServers declared', async () => {
    const catalog = new ToolCatalog();
    const listTools = vi.fn();
    await populateCatalogFromSkills({
      skills: [
        { name: 'weather', ok: true, frontmatter: { mcpServers: [] } } as never,
      ],
      getMcpClient: () => ({ listTools }) as never,
      catalog,
    });
    expect(catalog.list()).toEqual([]);
    expect(listTools).not.toHaveBeenCalled();
  });

  // Regression: a flaky 401 from one MCP server used to silently poison
  // the cache. The builder now reports per-server failures so the cache
  // can skip writes and the next turn retries.
  test('returns serverFailures > 0 when a server\'s listTools throws', async () => {
    const flaky = { listTools: vi.fn().mockRejectedValue(new Error('invalid_token')) };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => flaky as never,
      catalog,
    });
    expect(result.serverFailures).toBe(1);
    expect(result.toolRegisterFailures).toBe(0);
    expect(catalog.list()).toEqual([]);
  });

  test('returns serverFailures: 0 on clean build (idempotent success signal)', async () => {
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'list_issues', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'linear', ok: true, frontmatter: { mcpServers: [{ name: 'linear' }] } } as never,
      ],
      getMcpClient: () => client as never,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(0);
  });

  test('counts tool-register failures separately from server failures (dupes stay cache-safe)', async () => {
    // Two skills declare servers that advertise the same tool name. The
    // second registration throws — that's a deterministic clash, not a
    // transient failure. Separate counter so callers can keep caching.
    const client = {
      listTools: vi.fn().mockResolvedValue([{ name: 'shared_tool', inputSchema: {} }]),
    };
    const catalog = new ToolCatalog();
    const result = await populateCatalogFromSkills({
      skills: [
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
        { name: 'a', ok: true, frontmatter: { mcpServers: [{ name: 's' }] } } as never,
      ],
      getMcpClient: () => client as never,
      catalog,
    });
    expect(result.serverFailures).toBe(0);
    expect(result.toolRegisterFailures).toBe(1);
  });
});
