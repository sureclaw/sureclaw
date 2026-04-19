/**
 * Tests for MCP tool module generation.
 */

import { describe, it, expect } from 'vitest';
import { prepareToolModules } from '../../../src/host/toolgen/generate-and-cache.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('prepareToolModules', () => {
  it('generates module files + index', async () => {
    const tools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' } } }, server: 'linear' },
      { name: 'list_repos', description: 'List repos', inputSchema: { type: 'object', properties: {} }, server: 'github' },
    ];
    const result = await prepareToolModules({ agentName: 'test', tools });
    expect(result).not.toBeNull();
    expect(result!.files.find(f => f.path === 'linear.js')).toBeTruthy();
    expect(result!.files.find(f => f.path === 'github.js')).toBeTruthy();
    expect(result!.files.find(f => f.path === 'index.js')).toBeTruthy();
  });

  it('returns null for empty tools', async () => {
    const result = await prepareToolModules({ agentName: 'test', tools: [] });
    expect(result).toBeNull();
  });
});
