import type { DatabaseProvider } from '../providers/database/types.js';
import type { McpConnectionManager } from './mcp-manager.js';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'plugin-startup' });

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
          logger.warn('database_mcp_server_malformed_headers', { name: row.name });
        }
      }
      mcpManager.addServer('_', {
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
