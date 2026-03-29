/**
 * IPC handlers for Cowork plugin management (install / uninstall / list).
 *
 * These wrap the plugin install/uninstall/list functions from src/plugins/
 * and expose them as agent-callable IPC actions with the `_cowork` suffix
 * to avoid collision with the existing host-internal plugin_list/plugin_status.
 */

import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import type { McpConnectionManager } from '../../plugins/mcp-manager.js';
import type { ProxyDomainList } from '../proxy-domain-list.js';
import { installPlugin, uninstallPlugin } from '../../plugins/install.js';
import { listPlugins } from '../../plugins/store.js';

export interface CoworkPluginHandlerOptions {
  mcpManager: McpConnectionManager;
  domainList?: ProxyDomainList;
}

export function createCoworkPluginHandlers(
  providers: ProviderRegistry,
  opts: CoworkPluginHandlerOptions,
): Record<string, (req: any, ctx: IPCContext) => Promise<any>> {
  return {
    plugin_install_cowork: async (req: any, ctx: IPCContext) => {
      const agentId = ctx.agentId ?? 'main';
      if (!providers.storage?.documents) {
        return { installed: false, reason: 'No storage provider available' };
      }
      return installPlugin({
        source: req.source,
        agentId,
        documents: providers.storage.documents,
        mcpManager: opts.mcpManager,
        audit: providers.audit,
        domainList: opts.domainList,
        sessionId: ctx.sessionId,
      });
    },

    plugin_uninstall_cowork: async (req: any, ctx: IPCContext) => {
      const agentId = ctx.agentId ?? 'main';
      if (!providers.storage?.documents) {
        return { ok: false, reason: 'No storage provider available' };
      }
      return uninstallPlugin({
        pluginName: req.pluginName,
        agentId,
        documents: providers.storage.documents,
        mcpManager: opts.mcpManager,
        audit: providers.audit,
        domainList: opts.domainList,
        sessionId: ctx.sessionId,
      });
    },

    plugin_list_cowork: async (_req: any, ctx: IPCContext) => {
      const agentId = ctx.agentId ?? 'main';
      if (!providers.storage?.documents) {
        return { plugins: [] };
      }
      const plugins = await listPlugins(providers.storage.documents, agentId);
      return {
        plugins: plugins.map(p => ({
          name: p.pluginName,
          version: p.version,
          description: p.description,
          source: p.source,
          skills: p.skillCount,
          commands: p.commandCount,
          mcpServers: p.mcpServers.map(s => s.name),
          installedAt: p.installedAt,
        })),
      };
    },
  };
}
