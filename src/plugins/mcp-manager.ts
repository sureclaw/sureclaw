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
 * Global MCP connection manager.
 *
 * Tracks MCP server endpoints globally (shared across all agents). This is a
 * registry, not a connection pool. The actual MCP protocol connections happen
 * when prepareMcpCLIs() queries each server's tools at sandbox spin-up time.
 *
 * Server registry is global — all agents see the same set of MCP servers.
 * Tool name → server URL mappings remain per-agent since each agent session
 * discovers tools independently at runtime.
 */
export class McpConnectionManager {
  /** Global server registry (serverName → server). */
  private readonly servers = new Map<string, ManagedServer>();

  /** agentId → (toolName → serverUrl) — per-agent tool routing */
  private readonly toolServerMap = new Map<string, Map<string, string>>();

  addServer(_agentId: string, server: PluginMcpServer, optsOrPluginName?: string | AddServerOpts): void {
    let pluginName: string | undefined;
    let source: string | undefined;
    let headers: Record<string, string> | undefined;

    if (typeof optsOrPluginName === 'string') {
      pluginName = optsOrPluginName;
      source = `plugin:${optsOrPluginName}`;
    } else if (optsOrPluginName) {
      pluginName = optsOrPluginName.pluginName;
      source = optsOrPluginName.source ?? (pluginName ? `plugin:${pluginName}` : undefined);
      headers = optsOrPluginName.headers;
    }

    this.servers.set(server.name, { ...server, pluginName, source, headers });
  }

  removeServer(_agentId: string, serverName: string): boolean {
    const server = this.servers.get(serverName);
    if (server) {
      // Clear tool mappings for this server's URL across all agents
      this.clearToolsForUrlGlobal(server.url);
    }
    return this.servers.delete(serverName);
  }

  removeServersByPlugin(_agentId: string, pluginName: string): number {
    return this.removeServersBySource(_agentId, `plugin:${pluginName}`);
  }

  listServers(_agentId: string): PluginMcpServer[] {
    return [...this.servers.values()].map(({ pluginName: _, source: _s, headers: _h, ...rest }) => rest);
  }

  /**
   * List servers with source and headers metadata exposed.
   * Used by the unified registry to pass headers through to MCP calls.
   */
  listServersWithMeta(_agentId: string): Array<PluginMcpServer & { source?: string; headers?: Record<string, string> }> {
    return [...this.servers.values()].map(({ pluginName: _, ...rest }) => rest);
  }

  /**
   * Get metadata (source, headers) for a specific server.
   */
  getServerMeta(_agentId: string, name: string): { source?: string; headers?: Record<string, string> } | undefined {
    const server = this.servers.get(name);
    if (!server) return undefined;
    return { source: server.source, headers: server.headers };
  }

  /**
   * Get metadata (source, headers) for a server identified by its URL.
   * Used by the tool router which knows the server URL but not the server name.
   */
  getServerMetaByUrl(_agentId: string, url: string): { name?: string; source?: string; headers?: Record<string, string> } | undefined {
    for (const server of this.servers.values()) {
      if (server.url === url) {
        return { name: server.name, source: server.source, headers: server.headers };
      }
    }
    return undefined;
  }

  /**
   * Remove all servers matching a given source tag and clear their tool mappings.
   */
  removeServersBySource(_agentId: string, source: string): number {
    // Clear tool mappings BEFORE removing servers
    this.clearToolsForSourceGlobal(source);

    let count = 0;
    for (const [name, server] of this.servers) {
      if (server.source === source) {
        this.servers.delete(name);
        count++;
      }
    }
    return count;
  }

  getServerUrls(_agentId: string): string[] {
    return [...new Set([...this.servers.values()].map(s => s.url))];
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
    this.clearToolsForSourceGlobal(`plugin:${pluginName}`);
  }

  /**
   * Clear tool mappings for a specific server URL across all agents.
   */
  private clearToolsForUrlGlobal(url: string): void {
    for (const agentTools of this.toolServerMap.values()) {
      for (const [toolName, toolUrl] of agentTools) {
        if (toolUrl === url) agentTools.delete(toolName);
      }
    }
  }

  /**
   * Clear tool mappings for a specific server URL for one agent.
   */
  private clearToolsForUrl(agentId: string, url: string): void {
    const agentTools = this.toolServerMap.get(agentId);
    if (!agentTools) return;
    for (const [toolName, toolUrl] of agentTools) {
      if (toolUrl === url) agentTools.delete(toolName);
    }
  }

  /**
   * Clear tool mappings for all servers matching a given source tag across all agents.
   */
  private clearToolsForSourceGlobal(source: string): void {
    const sourceUrls = new Set<string>();
    for (const server of this.servers.values()) {
      if (server.source === source) sourceUrls.add(server.url);
    }

    for (const agentTools of this.toolServerMap.values()) {
      for (const [toolName, url] of agentTools) {
        if (sourceUrls.has(url)) agentTools.delete(toolName);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Unified tool discovery
  // ---------------------------------------------------------------------------

  /**
   * Discover tools from ALL registered global MCP servers.
   * Resolves credential placeholders in headers if a resolver is provided.
   * For servers without explicit headers, calls `authForServer` to attempt
   * credential-based auth from the credential store.
   * Registers tool->server URL mappings for the given agent.
   */
  async discoverAllTools(
    agentId: string,
    opts?: {
      resolveHeaders?: (headers: Record<string, string>) => Promise<Record<string, string>>;
      /** Provide auth headers for servers that have no explicit headers configured.
       *  Called with the server name and URL; should return headers or undefined. */
      authForServer?: (server: { name: string; url: string }) => Promise<Record<string, string> | undefined>;
      /** When set, only discover tools from servers whose name is in this set.
       *  Used to respect per-agent connector assignments (agent_mcp_servers). */
      serverFilter?: Set<string>;
    },
  ): Promise<McpToolSchema[]> {
    const allTools: McpToolSchema[] = [];

    for (const [, server] of this.servers) {
      if (opts?.serverFilter && !opts.serverFilter.has(server.name)) continue;
      try {
        let resolvedHeaders: Record<string, string> | undefined;
        if (server.headers && opts?.resolveHeaders) {
          resolvedHeaders = await opts.resolveHeaders(server.headers);
        } else if (!server.headers && opts?.authForServer) {
          resolvedHeaders = await opts.authForServer({ name: server.name, url: server.url });
        } else {
          resolvedHeaders = server.headers;
        }

        const tools = await listToolsFromServer(server.url, resolvedHeaders ? { headers: resolvedHeaders } : undefined);
        // Clear stale tool mappings for this server URL before registering new ones
        this.clearToolsForUrl(agentId, server.url);
        if (tools.length > 0) {
          this.registerTools(agentId, server.url, tools.map(t => t.name));
          // Tag each tool with its source server name for codegen grouping
          allTools.push(...tools.map(t => ({ ...t, server: server.name })));
        }
      } catch {
        // One server failing doesn't affect others
      }
    }
    return allTools;
  }
}
