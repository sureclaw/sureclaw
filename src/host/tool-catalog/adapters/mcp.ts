import { minimatch } from 'minimatch';
import type { CatalogTool } from '../types.js';

interface McpToolInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface BuildMcpCatalogToolsInput {
  skill: string;
  server: string;
  tools: McpToolInput[];
  include?: string[];
  exclude?: string[];
}

export function buildMcpCatalogTools(input: BuildMcpCatalogToolsInput): CatalogTool[] {
  const filtered = input.tools.filter(t => {
    if (input.include?.length && !input.include.some(g => minimatch(t.name, g))) return false;
    if (input.exclude?.length && input.exclude.some(g => minimatch(t.name, g))) return false;
    return true;
  });

  return filtered.map(t => ({
    name: `mcp_${input.skill}_${t.name}`,
    skill: input.skill,
    summary: t.description ?? t.name,
    schema: t.inputSchema ?? { type: 'object' },
    dispatch: { kind: 'mcp' as const, server: input.server, toolName: t.name },
  }));
}
