/**
 * IPC handlers for plugin management queries.
 *
 * These are host-internal actions (not agent-facing tools) that let
 * the server report plugin status via IPC.
 */

import type { ProviderRegistry } from '../../types.js';
import type { IPCContext } from '../ipc-server.js';
import { listPluginProviders } from '../provider-map.js';

export function createPluginHandlers(
  _providers: ProviderRegistry,
): Record<string, (req: any, ctx: IPCContext) => Promise<any>> {
  return {
    plugin_list: async () => {
      const plugins = listPluginProviders();
      return { plugins };
    },

    plugin_status: async (req: { packageName: string }) => {
      const plugins = listPluginProviders();
      const plugin = plugins.find(p => `${p.kind}/${p.name}` === req.packageName || p.modulePath.includes(req.packageName));
      if (!plugin) {
        return { found: false };
      }
      return { found: true, ...plugin };
    },
  };
}
