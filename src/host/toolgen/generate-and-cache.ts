/**
 * Generates MCP CLI executables and tool modules from tool schemas.
 *
 * Called when preparing a sandbox. One executable per MCP server,
 * sent via stdin payload and written to /workspace/bin/ by applyPayload().
 *
 * prepareToolModules() generates importable JS modules (one per server)
 * plus a barrel index and compact index string for the system prompt.
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';
import type { ToolStubFile } from '../../providers/storage/tool-stubs.js';
import {
  generateCLI,
  generateModule,
  generateIndex,
  generateCompactIndex,
  groupToolsByServer,
} from './codegen.js';

export interface PrepareMcpCLIsOptions {
  agentName: string;
  tools: McpToolSchema[];
}

export async function prepareMcpCLIs(
  opts: PrepareMcpCLIsOptions,
): Promise<ToolStubFile[] | null> {
  const { tools } = opts;
  if (tools.length === 0) return null;

  const groups = groupToolsByServer(tools);
  const files: ToolStubFile[] = [];

  for (const group of groups) {
    const content = generateCLI(group.server, group.tools);
    files.push({ path: group.server, content });
  }

  return files.length > 0 ? files : null;
}

// ---------------------------------------------------------------------------
// Tool module generation (PTC model)
// ---------------------------------------------------------------------------

export interface PrepareToolModulesResult {
  /** Module files: one .js per server + index.js barrel. */
  files: ToolStubFile[];
  /** Compact one-line-per-server summary for the system prompt. */
  compactIndex: string;
}

export async function prepareToolModules(
  opts: PrepareMcpCLIsOptions,
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

  // Barrel index re-exporting all server modules
  const servers = groups.map(g => g.server);
  const indexContent = generateIndex(servers);
  files.push({ path: 'index.js', content: indexContent });

  // Compact summary for the system prompt
  const compactIndex = generateCompactIndex(groups);

  return { files, compactIndex };
}
