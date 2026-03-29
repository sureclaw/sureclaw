import type { PluginMcpServer } from './types.js';
import { listToolsFromServer } from './mcp-client.js';
import type { McpToolSchema } from '../providers/mcp/types.js';

interface ManagedServer extends PluginMcpServer {
  pluginName?: string;
  source?: string;
  headers?: Record<string, string>;
}

/** Options for addServer (new calling convention). */
export interface AddServerOpts {
  source?: string;
  pluginName?: string;
  headers?: Record<string, string>;
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

  addServer(agentId: string, server: PluginMcpServer, optsOrPluginName?: string | AddServerOpts): void {
    let agentServers = this.servers.get(agentId);
    if (!agentServers) {
      agentServers = new Map();
      this.servers.set(agentId, agentServers);
    }

    let pluginName: string | undefined;
    let source: string | undefined;
    let headers: Record<string, string> | undefined;

    if (typeof optsOrPluginName === 'string') {
      // Backward-compat: string arg is pluginName, derive source
      pluginName = optsOrPluginName;
      source = `plugin:${optsOrPluginName}`;
    } else if (optsOrPluginName) {
      pluginName = optsOrPluginName.pluginName;
      source = optsOrPluginName.source ?? (pluginName ? `plugin:${pluginName}` : undefined);
      headers = optsOrPluginName.headers;
    }

    agentServers.set(server.name, { ...server, pluginName, source, headers });
  }

  removeServer(agentId: string, serverName: string): boolean {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return false;
    const server = agentServers.get(serverName);
    if (server) {
      // Clear tool mappings for this server's URL before removing
      this.clearToolsForUrl(agentId, server.url);
    }
    return agentServers.delete(serverName);
  }

  removeServersByPlugin(agentId: string, pluginName: string): number {
    return this.removeServersBySource(agentId, `plugin:${pluginName}`);
  }

  listServers(agentId: string): PluginMcpServer[] {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return [];
    return [...agentServers.values()].map(({ pluginName: _, source: _s, headers: _h, ...rest }) => rest);
  }

  /**
   * List servers with source and headers metadata exposed.
   * Used by the unified registry to pass headers through to MCP calls.
   */
  listServersWithMeta(agentId: string): Array<PluginMcpServer & { source?: string; headers?: Record<string, string> }> {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return [];
    return [...agentServers.values()].map(({ pluginName: _, ...rest }) => rest);
  }

  /**
   * Get metadata (source, headers) for a specific server.
   */
  getServerMeta(agentId: string, name: string): { source?: string; headers?: Record<string, string> } | undefined {
    const server = this.servers.get(agentId)?.get(name);
    if (!server) return undefined;
    return { source: server.source, headers: server.headers };
  }

  /**
   * Get metadata (source, headers) for a server identified by its URL.
   * Used by the tool router which knows the server URL but not the server name.
   */
  getServerMetaByUrl(agentId: string, url: string): { source?: string; headers?: Record<string, string> } | undefined {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return undefined;
    for (const server of agentServers.values()) {
      if (server.url === url) {
        return { source: server.source, headers: server.headers };
      }
    }
    return undefined;
  }

  /**
   * Remove all servers matching a given source tag and clear their tool mappings.
   */
  removeServersBySource(agentId: string, source: string): number {
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return 0;

    // Clear tool mappings BEFORE removing servers (needs server URLs to find tools)
    this.clearToolsForSource(agentId, source);

    let count = 0;
    for (const [name, server] of agentServers) {
      if (server.source === source) {
        agentServers.delete(name);
        count++;
      }
    }
    return count;
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
    this.clearToolsForSource(agentId, `plugin:${pluginName}`);
  }

  /**
   * Clear tool mappings for a specific server URL.
   */
  private clearToolsForUrl(agentId: string, url: string): void {
    const agentTools = this.toolServerMap.get(agentId);
    if (!agentTools) return;
    for (const [toolName, toolUrl] of agentTools) {
      if (toolUrl === url) agentTools.delete(toolName);
    }
  }

  /**
   * Clear tool mappings for all servers matching a given source tag.
   */
  private clearToolsForSource(agentId: string, source: string): void {
    const agentServers = this.servers.get(agentId);
    const agentTools = this.toolServerMap.get(agentId);
    if (!agentServers || !agentTools) return;

    const sourceUrls = new Set<string>();
    for (const server of agentServers.values()) {
      if (server.source === source) sourceUrls.add(server.url);
    }

    for (const [toolName, url] of agentTools) {
      if (sourceUrls.has(url)) agentTools.delete(toolName);
    }
  }

  // ---------------------------------------------------------------------------
  // Unified tool discovery
  // ---------------------------------------------------------------------------

  /**
   * Discover tools from ALL registered MCP servers for an agent.
   * Resolves credential placeholders in headers if a resolver is provided.
   * Registers tool->server URL mappings for later routing.
   */
  async discoverAllTools(
    agentId: string,
    opts?: {
      resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
    },
  ): Promise<McpToolSchema[]> {
    const allTools: McpToolSchema[] = [];
    const agentServers = this.servers.get(agentId);
    if (!agentServers) return allTools;

    for (const [, server] of agentServers) {
      try {
        const resolvedHeaders = server.headers && opts?.resolveHeaders
          ? await opts.resolveHeaders(server.headers)
          : server.headers;

        const tools = await listToolsFromServer(server.url, resolvedHeaders ? { headers: resolvedHeaders } : undefined);
        // Clear stale tool mappings for this server URL before registering new ones
        this.clearToolsForUrl(agentId, server.url);
        if (tools.length > 0) {
          this.registerTools(agentId, server.url, tools.map(t => t.name));
          allTools.push(...tools);
        }
      } catch {
        // One server failing doesn't affect others
      }
    }
    return allTools;
  }
}
