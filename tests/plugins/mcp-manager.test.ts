import { describe, it, expect, beforeEach } from 'vitest';
import { McpConnectionManager } from '../../src/plugins/mcp-manager.js';

describe('McpConnectionManager', () => {
  let manager: McpConnectionManager;

  beforeEach(() => {
    manager = new McpConnectionManager();
  });

  it('starts with no connections', () => {
    expect(manager.listServers('pi')).toEqual([]);
  });

  it('registers an MCP server for an agent', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    const servers = manager.listServers('pi');
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('slack');
    expect(servers[0].url).toBe('https://mcp.slack.com/mcp');
  });

  it('shares global server registry across agents', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    manager.addServer('counsel', { name: 'docusign', type: 'http', url: 'https://mcp.docusign.com/mcp' });
    // Server registry is global — all agents see every server.
    // Per-agent filtering happens at discovery time via serverFilter.
    expect(manager.listServers('pi')).toHaveLength(2);
    expect(manager.listServers('counsel')).toHaveLength(2);
  });

  it('removes a server', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    expect(manager.removeServer('pi', 'slack')).toBe(true);
    expect(manager.listServers('pi')).toEqual([]);
  });

  it('returns false when removing nonexistent server', () => {
    expect(manager.removeServer('pi', 'slack')).toBe(false);
  });

  it('removes all servers for a plugin', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, 'sales');
    manager.addServer('pi', { name: 'hubspot', type: 'http', url: 'https://mcp.hubspot.com/mcp' }, 'sales');
    manager.addServer('pi', { name: 'box', type: 'http', url: 'https://mcp.box.com/mcp' }, 'legal');
    expect(manager.removeServersByPlugin('pi', 'sales')).toBe(2);
    expect(manager.listServers('pi')).toHaveLength(1);
    expect(manager.listServers('pi')[0].name).toBe('box');
  });

  it('returns deduplicated server URLs', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    manager.addServer('pi', { name: 'hubspot', type: 'http', url: 'https://mcp.hubspot.com/mcp' });
    const urls = manager.getServerUrls('pi');
    expect(urls).toHaveLength(2);
    expect(urls).toContain('https://mcp.slack.com/mcp');
    expect(urls).toContain('https://mcp.hubspot.com/mcp');
  });

  it('does not expose internal pluginName in listServers', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, 'sales');
    const servers = manager.listServers('pi');
    expect(servers[0]).toEqual({ name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    expect((servers[0] as any).pluginName).toBeUndefined();
  });

  // ── Tool → server URL mapping ──

  it('registers tools and resolves tool name to server URL', () => {
    manager.registerTools('pi', 'https://mcp.slack.com/mcp', [
      'slack_send_message',
      'slack_list_channels',
    ]);
    expect(manager.getToolServerUrl('pi', 'slack_send_message')).toBe('https://mcp.slack.com/mcp');
    expect(manager.getToolServerUrl('pi', 'slack_list_channels')).toBe('https://mcp.slack.com/mcp');
  });

  it('returns undefined for unknown tool names', () => {
    expect(manager.getToolServerUrl('pi', 'unknown_tool')).toBeUndefined();
  });

  it('returns undefined for unknown agent in tool lookup', () => {
    manager.registerTools('pi', 'https://mcp.slack.com/mcp', ['slack_send_message']);
    expect(manager.getToolServerUrl('counsel', 'slack_send_message')).toBeUndefined();
  });

  it('scopes tool registrations to agents', () => {
    manager.registerTools('pi', 'https://mcp.slack.com/mcp', ['slack_send_message']);
    manager.registerTools('counsel', 'https://mcp.docusign.com/mcp', ['docusign_send']);
    expect(manager.getToolServerUrl('pi', 'slack_send_message')).toBe('https://mcp.slack.com/mcp');
    expect(manager.getToolServerUrl('pi', 'docusign_send')).toBeUndefined();
    expect(manager.getToolServerUrl('counsel', 'docusign_send')).toBe('https://mcp.docusign.com/mcp');
  });

  it('overwrites tool mapping when re-registered to a different server', () => {
    manager.registerTools('pi', 'https://old.server/mcp', ['my_tool']);
    manager.registerTools('pi', 'https://new.server/mcp', ['my_tool']);
    expect(manager.getToolServerUrl('pi', 'my_tool')).toBe('https://new.server/mcp');
  });

  it('clears tool mappings when removing servers by plugin', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, 'sales');
    manager.addServer('pi', { name: 'hubspot', type: 'http', url: 'https://mcp.hubspot.com/mcp' }, 'sales');
    manager.addServer('pi', { name: 'box', type: 'http', url: 'https://mcp.box.com/mcp' }, 'legal');

    manager.registerTools('pi', 'https://mcp.slack.com/mcp', ['slack_send']);
    manager.registerTools('pi', 'https://mcp.hubspot.com/mcp', ['hubspot_create']);
    manager.registerTools('pi', 'https://mcp.box.com/mcp', ['box_upload']);

    // Remove 'sales' plugin — should clear slack and hubspot tools
    manager.removeServersByPlugin('pi', 'sales');

    expect(manager.getToolServerUrl('pi', 'slack_send')).toBeUndefined();
    expect(manager.getToolServerUrl('pi', 'hubspot_create')).toBeUndefined();
    // 'legal' plugin tools should remain
    expect(manager.getToolServerUrl('pi', 'box_upload')).toBe('https://mcp.box.com/mcp');
  });

  // ── Source tags and headers ──

  it('tracks source on registered servers', () => {
    manager.addServer('pi', { name: 'github', type: 'http', url: 'https://mcp.github.com/mcp' }, {
      source: 'db:org-tools',
      pluginName: 'gh',
    });
    const meta = manager.getServerMeta('pi', 'github');
    expect(meta).toBeDefined();
    expect(meta!.source).toBe('db:org-tools');
  });

  it('stores headers for database-sourced servers', () => {
    manager.addServer('pi', { name: 'stripe', type: 'http', url: 'https://mcp.stripe.com/mcp' }, {
      source: 'db:billing',
      headers: { Authorization: 'Bearer sk_live_xxx' },
    });
    const meta = manager.getServerMeta('pi', 'stripe');
    expect(meta).toBeDefined();
    expect(meta!.headers).toEqual({ Authorization: 'Bearer sk_live_xxx' });
  });

  it('stores transport on registered servers + exposes it via getServerMeta', () => {
    manager.addServer('pi', {
      name: 'linear',
      type: 'http',
      url: 'https://mcp.linear.app/sse',
      transport: 'sse',
    });
    const meta = manager.getServerMeta('pi', 'linear');
    expect(meta).toBeDefined();
    expect(meta!.transport).toBe('sse');
  });

  it('getServerMetaByUrl returns transport when declared', () => {
    manager.addServer('pi', {
      name: 'linear',
      type: 'http',
      url: 'https://mcp.linear.app/sse',
      transport: 'sse',
    });
    const meta = manager.getServerMetaByUrl('pi', 'https://mcp.linear.app/sse');
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('linear');
    expect(meta!.transport).toBe('sse');
  });

  it('getServerMeta returns transport undefined when not declared (http default is set at the schema layer)', () => {
    // `McpConnectionManager` doesn't impose a default — the
    // frontmatter schema + provider layer handle that. Raw addServer
    // without transport leaves meta.transport unset.
    manager.addServer('pi', {
      name: 'slack',
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
    });
    const meta = manager.getServerMeta('pi', 'slack');
    expect(meta).toBeDefined();
    expect(meta!.transport).toBeUndefined();
  });

  it('removeServersBySource removes all servers from a source', () => {
    manager.addServer('pi', { name: 'github', type: 'http', url: 'https://mcp.github.com/mcp' }, {
      source: 'db:org-tools',
    });
    manager.addServer('pi', { name: 'jira', type: 'http', url: 'https://mcp.jira.com/mcp' }, {
      source: 'db:org-tools',
    });
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, {
      source: 'plugin:comms',
    });

    manager.registerTools('pi', 'https://mcp.github.com/mcp', ['gh_pr']);
    manager.registerTools('pi', 'https://mcp.jira.com/mcp', ['jira_create']);
    manager.registerTools('pi', 'https://mcp.slack.com/mcp', ['slack_send']);

    expect(manager.removeServersBySource('pi', 'db:org-tools')).toBe(2);
    expect(manager.listServers('pi')).toHaveLength(1);
    expect(manager.listServers('pi')[0].name).toBe('slack');

    // Tool mappings for removed source should be cleared
    expect(manager.getToolServerUrl('pi', 'gh_pr')).toBeUndefined();
    expect(manager.getToolServerUrl('pi', 'jira_create')).toBeUndefined();
    // Other source tools remain
    expect(manager.getToolServerUrl('pi', 'slack_send')).toBe('https://mcp.slack.com/mcp');
  });

  it('backward compat: string pluginName still works', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, 'sales');
    const meta = manager.getServerMeta('pi', 'slack');
    expect(meta).toBeDefined();
    // String pluginName should derive source as 'plugin:<name>'
    expect(meta!.source).toBe('plugin:sales');
  });

  it('listServersWithMeta exposes source and headers', () => {
    manager.addServer('pi', { name: 'stripe', type: 'http', url: 'https://mcp.stripe.com/mcp' }, {
      source: 'db:billing',
      headers: { Authorization: 'Bearer sk_live_xxx' },
    });
    const servers = manager.listServersWithMeta('pi');
    expect(servers).toHaveLength(1);
    expect(servers[0].source).toBe('db:billing');
    expect(servers[0].headers).toEqual({ Authorization: 'Bearer sk_live_xxx' });
    expect(servers[0].name).toBe('stripe');
  });

  it('listServersWithMeta returns empty for unknown agent', () => {
    expect(manager.listServersWithMeta('unknown')).toEqual([]);
  });

  it('getServerMeta returns undefined for unknown server', () => {
    expect(manager.getServerMeta('pi', 'nonexistent')).toBeUndefined();
  });

  it('ensureToolsDiscoveredForHead runs discovery only once per (agent, head)', async () => {
    // Regression: subprocess-sandbox completions used to rely on
    // admin refresh-tools to populate the toolServerMap. On pod restart
    // the in-memory map got wiped, and the turn path had no trigger to
    // repopulate it — so generated tool stubs compiled fine, but at
    // call time `resolveServer(agentId, 'get_team')` returned undefined
    // and the handler emitted "MCP gateway not configured for this tool".
    // This cache-keyed dedup lets the completion path ask for discovery
    // every turn while actually running it only once per (agent, HEAD
    // SHA) — cheap on cache hit, automatic on pod restart.
    manager.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/sse' }, { source: 'skill' });

    const { vi } = await import('vitest');
    const mcpClient = await import('../../src/plugins/mcp-client.js');
    let callCount = 0;
    const spy = vi.spyOn(mcpClient, 'listToolsFromServer').mockImplementation(async () => {
      callCount++;
      return [{ name: 'list_teams', description: 't', inputSchema: {} }];
    });

    // First call at HEAD sha-aaa → runs discovery
    await manager.ensureToolsDiscoveredForHead('pi', 'sha-aaa', {});
    expect(callCount).toBe(1);
    expect(manager.getToolServerUrl('pi', 'list_teams')).toBe('https://mcp.linear.app/sse');

    // Second call at same HEAD → no-op
    await manager.ensureToolsDiscoveredForHead('pi', 'sha-aaa', {});
    expect(callCount).toBe(1);

    // Third call at a different HEAD → runs discovery again (workspace changed)
    await manager.ensureToolsDiscoveredForHead('pi', 'sha-bbb', {});
    expect(callCount).toBe(2);

    // Per-agent isolation — a different agent starts cold even at the same HEAD
    await manager.ensureToolsDiscoveredForHead('other-agent', 'sha-aaa', {});
    expect(callCount).toBe(3);

    spy.mockRestore();
  });

  it('ensureToolsDiscoveredForHead skips cache on force:true', async () => {
    // Escape hatch for admin refresh-tools: the button click should re-run
    // discovery even if the HEAD hasn't changed, because the admin may
    // have tweaked credentials or swapped an MCP server version out.
    manager.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/sse' }, { source: 'skill' });

    const { vi } = await import('vitest');
    const mcpClient = await import('../../src/plugins/mcp-client.js');
    let callCount = 0;
    const spy = vi.spyOn(mcpClient, 'listToolsFromServer').mockImplementation(async () => {
      callCount++;
      return [];
    });

    await manager.ensureToolsDiscoveredForHead('pi', 'sha-aaa', {});
    expect(callCount).toBe(1);
    await manager.ensureToolsDiscoveredForHead('pi', 'sha-aaa', { force: true });
    expect(callCount).toBe(2);

    spy.mockRestore();
  });

  it('discoverAllTools respects serverFilter', async () => {
    // Register multiple servers
    manager.addServer('_', { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp' }, { source: 'database' });
    manager.addServer('_', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' }, { source: 'database' });
    manager.addServer('_', { name: 'github', type: 'http', url: 'https://api.github.com/mcp' }, { source: 'database' });

    // Mock listToolsFromServer to track which URLs were called
    const calledUrls: string[] = [];
    const { vi } = await import('vitest');
    const mcpClient = await import('../../src/plugins/mcp-client.js');
    const spy = vi.spyOn(mcpClient, 'listToolsFromServer').mockImplementation(async (url) => {
      calledUrls.push(url);
      return [{ name: 'test_tool', description: 'test', inputSchema: {} }];
    });

    // With filter: only linear
    await manager.discoverAllTools('pi', { serverFilter: new Set(['linear']) });
    expect(calledUrls).toEqual(['https://mcp.linear.app/mcp']);

    // Without filter: all servers
    calledUrls.length = 0;
    await manager.discoverAllTools('pi', {});
    expect(calledUrls).toHaveLength(3);

    spy.mockRestore();
  });
});
