import type { DocumentStore } from '../providers/storage/types.js';
import type { AuditProvider } from '../providers/audit/types.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import type { Config } from '../types.js';
import type { McpConnectionManager } from './mcp-manager.js';
import { listPlugins } from './store.js';
import { installPlugin } from './install.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'plugin-startup' });

/**
 * Repopulate the in-memory McpConnectionManager from stored plugin records.
 * Called on server startup since the manager is not persisted.
 */
export async function reloadPluginMcpServers(
  documents: DocumentStore,
  mcpManager: McpConnectionManager,
): Promise<void> {
  const allKeys = await documents.list('plugins');
  const agentIds = new Set(allKeys.map(k => k.split('/')[0]));

  let totalServers = 0;
  for (const agentId of agentIds) {
    const plugins = await listPlugins(documents, agentId);
    for (const plugin of plugins) {
      for (const server of plugin.mcpServers) {
        mcpManager.addServer(agentId, server, plugin.pluginName);
        totalServers++;
      }
    }
  }

  if (totalServers > 0) {
    logger.info('plugin_mcp_servers_reloaded', { agentCount: agentIds.size, serverCount: totalServers });
  }
}

/**
 * Auto-install plugins declared in config.plugins that aren't already in the DB.
 */
export async function autoInstallDeclaredPlugins(
  config: Config,
  documents: DocumentStore,
  mcpManager: McpConnectionManager,
  audit?: AuditProvider,
): Promise<void> {
  if (!config.plugins?.length) return;

  for (const decl of config.plugins) {
    for (const agentId of decl.agents) {
      // Check if any plugin from this source is already installed for this agent
      const existing = await listPlugins(documents, agentId);
      const alreadyInstalled = existing.some(p => p.source === decl.source);
      if (alreadyInstalled) continue;

      logger.info('auto_installing_plugin', { source: decl.source, agentId });
      try {
        const result = await installPlugin({
          source: decl.source,
          agentId,
          documents,
          mcpManager,
          audit,
          sessionId: 'startup',
        });
        if (result.installed) {
          logger.info('auto_install_complete', { pluginName: result.pluginName, agentId });
        } else {
          logger.warn('auto_install_failed', { source: decl.source, agentId, reason: result.reason });
        }
      } catch (err) {
        logger.warn('auto_install_error', { source: decl.source, agentId, error: (err as Error).message });
      }
    }
  }
}

/**
 * Load MCP servers from the mcp_servers DB table into the manager.
 * These are servers configured via `ax mcp add` or the admin dashboard.
 */
export async function loadDatabaseMcpServers(
  database: DatabaseProvider | undefined,
  mcpManager: McpConnectionManager,
): Promise<void> {
  if (!database) return;
  try {
    const rows = await database.db
      .selectFrom('mcp_servers')
      .selectAll()
      .where('enabled', '=', 1)
      .execute() as Array<{
        agent_id: string;
        name: string;
        url: string;
        headers: string | null;
      }>;

    let count = 0;
    for (const row of rows) {
      let headers: Record<string, string> | undefined;
      if (row.headers) {
        try {
          headers = JSON.parse(row.headers);
        } catch {
          logger.warn('database_mcp_server_malformed_headers', { name: row.name, agentId: row.agent_id });
        }
      }
      mcpManager.addServer(row.agent_id, {
        name: row.name,
        type: 'http',
        url: row.url,
      }, {
        source: 'database',
        headers,
      });
      count++;
    }

    if (count > 0) {
      logger.info('database_mcp_servers_loaded', { count });
    }
  } catch {
    // mcp_servers table may not exist yet — skip silently
  }
}
