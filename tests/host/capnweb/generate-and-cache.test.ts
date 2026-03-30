/**
 * Tests for MCP CLI generation.
 */

import { describe, it, expect } from 'vitest';
import { prepareMcpCLIs } from '../../../src/host/capnweb/generate-and-cache.js';
import type { McpToolSchema } from '../../../src/providers/mcp/types.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('prepareMcpCLIs', () => {
  it('generates one CLI file per server', async () => {
    const tools: McpToolSchema[] = [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' } } }, server: 'linear' },
      { name: 'get_issue', description: 'Get issue', inputSchema: { type: 'object', properties: { id: { type: 'string' } } }, server: 'linear' },
      { name: 'list_repos', description: 'List repos', inputSchema: { type: 'object', properties: {} }, server: 'github' },
    ];
    const result = await prepareMcpCLIs({ agentName: 'test', tools });
    expect(result).toHaveLength(2);
    expect(result!.find(f => f.path === 'linear')).toBeTruthy();
    expect(result!.find(f => f.path === 'github')).toBeTruthy();
    expect(result![0].content).toMatch(/^#!\/usr\/bin\/env node/);
  });

  it('returns null for empty tools', async () => {
    const result = await prepareMcpCLIs({ agentName: 'test', tools: [] });
    expect(result).toBeNull();
  });
});
