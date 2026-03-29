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

  it('scopes servers to agents', () => {
    manager.addServer('pi', { name: 'slack', type: 'http', url: 'https://mcp.slack.com/mcp' });
    manager.addServer('counsel', { name: 'docusign', type: 'http', url: 'https://mcp.docusign.com/mcp' });
    expect(manager.listServers('pi')).toHaveLength(1);
    expect(manager.listServers('counsel')).toHaveLength(1);
    expect(manager.listServers('pi')[0].name).toBe('slack');
    expect(manager.listServers('counsel')[0].name).toBe('docusign');
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
});
