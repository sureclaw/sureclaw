import type { PluginMcpServer } from './types.js';

interface ManagedServer extends PluginMcpServer {
  pluginName?: string;
}

/**
 * Per-agent MCP connection manager.
 *
 * Tracks MCP server endpoints per agent. This is a registry, not a connection
 * pool. The actual MCP protocol connections happen when prepareToolStubs()
 * queries each server's tools at sandbox spin-up time.
 *
 * Also maintains a tool name → server URL mapping so that the tool router
 * can dispatch plugin MCP tool calls to the correct remote server without
 * a second discovery round-trip.
 */
export class McpConnectionManager {
  private readonly servers = new Map<string, Map<string, ManagedServer>>();

  /** agentId → (toolName → serverUrl) */
  private readonly toolServerMap = new Map<string, Map<string, string>>();

  addServer(agentId: string, server: PluginMcpServer, pluginName?: string): void {
    let agentServers = this.servers.get(agentId);
    if (!agentServers) {
      agentServers = new Map();
      this.servers.set(agentId, agentServers);
    }
    agentServers.set(server.name, { ...server, pluginName });
  }

  removeServer(agentId: string, serverName: string): boolean {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return false;
    return agentServers.delete(serverName);
  }

  removeServersByPlugin(agentId: string, pluginName: string): number {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return 0;
    // Clear tool mappings BEFORE removing servers (needs server URLs to find tools)
    this.clearToolsForPlugin(agentId, pluginName);
    let count = 0;
    for (const [name, server] of agentServers) {
      if (server.pluginName === pluginName) {
        agentServers.delete(name);
        count++;
      }
    }
    return count;
  }

  listServers(agentId: string): PluginMcpServer[] {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return [];
    return [...agentServers.values()].map(({ pluginName: _, ...rest }) => rest);
  }

  getServerUrls(agentId: string): string[] {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return [];
    return [...new Set([...agentServers.values()].map(s => s.url))];
  }

  // ---------------------------------------------------------------------------
  // Tool → server URL mapping
  // ---------------------------------------------------------------------------

  /**
   * Register tool names discovered from a plugin MCP server. Called during
   * tool discovery (listToolsFromServer) so the tool router knows which
   * server URL handles each tool.
   */
  registerTools(agentId: string, serverUrl: string, toolNames: string[]): void {
    let agentTools = this.toolServerMap.get(agentId);
    if (!agentTools) {
      agentTools = new Map();
      this.toolServerMap.set(agentId, agentTools);
    }
    for (const name of toolNames) {
      agentTools.set(name, serverUrl);
    }
  }

  /**
   * Look up which plugin MCP server URL handles a given tool for an agent.
   * Returns undefined if the tool is not from a plugin server (i.e., it
   * should fall through to the default MCP provider).
   */
  getToolServerUrl(agentId: string, toolName: string): string | undefined {
    return this.toolServerMap.get(agentId)?.get(toolName);
  }

  /**
   * Clear tool mappings for all servers belonging to a specific plugin.
   * Called when a plugin is uninstalled so stale tool routes are removed.
   */
  clearToolsForPlugin(agentId: string, pluginName: string): void {
    const agentServers = this.servers.get(agentId);
    const agentTools = this.toolServerMap.get(agentId);
    if (!agentServers || !agentTools) return;

    const pluginUrls = new Set<string>();
    for (const server of agentServers.values()) {
      if (server.pluginName === pluginName) pluginUrls.add(server.url);
    }

    for (const [toolName, url] of agentTools) {
      if (pluginUrls.has(url)) agentTools.delete(toolName);
    }
  }
}
