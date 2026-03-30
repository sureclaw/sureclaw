/**
 * Generates MCP CLI executables from tool schemas.
 *
 * Called when preparing a sandbox. One executable per MCP server,
 * sent via stdin payload and written to agentWorkspace/bin/ by applyPayload().
 */

import type { McpToolSchema } from '../../providers/mcp/types.js';
import type { ToolStubFile } from '../../providers/storage/tool-stubs.js';
import { generateCLI, groupToolsByServer } from './codegen.js';

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
