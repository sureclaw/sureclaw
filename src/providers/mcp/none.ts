// src/providers/mcp/none.ts — No-op MCP provider for dev/test and sandbox-only agents
import type { McpProvider } from './types.js';
import type { Config } from '../../types.js';
import { disabledProvider } from '../../utils/disabled-provider.js';

export async function create(_config: Config): Promise<McpProvider> {
  return disabledProvider<McpProvider>();
}
