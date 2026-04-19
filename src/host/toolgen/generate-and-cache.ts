/**
 * Generates MCP tool modules from tool schemas.
 *
 * prepareToolModules() generates importable JS modules (one per server)
 * plus a barrel index.
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';
import type { ToolStubFile } from '../../providers/storage/tool-stubs.js';
import {
  generateModule,
  generateIndex,
  groupToolsByServer,
} from './codegen.js';

export interface PrepareToolModulesOptions {
  agentName: string;
  tools: McpToolSchema[];
}

export interface PrepareToolModulesResult {
  /** Module files: one .js per server + index.js barrel. */
  files: ToolStubFile[];
}

export async function prepareToolModules(
  opts: PrepareToolModulesOptions,
): Promise<PrepareToolModulesResult | null> {
  const { tools } = opts;
  if (tools.length === 0) return null;

  const groups = groupToolsByServer(tools);
  const files: ToolStubFile[] = [];

  for (const group of groups) {
    const content = generateModule(group.server, group.tools);
    files.push({ path: `${group.server}.js`, content });
  }

  if (files.length === 0) return null;

  const servers = groups.map(g => g.server);
  const indexContent = generateIndex(servers);
  files.push({ path: 'index.js', content: indexContent });

  return { files };
}
