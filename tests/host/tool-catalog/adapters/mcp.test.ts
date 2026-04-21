import { describe, test, expect } from 'vitest';
import { buildMcpCatalogTools } from '../../../../src/host/tool-catalog/adapters/mcp.js';

describe('buildMcpCatalogTools', () => {
  test('maps MCP tools to CatalogTool entries', () => {
    const mcpTools = [
      { name: 'list_issues', description: 'List issues in a cycle', inputSchema: { type: 'object', properties: { team: { type: 'string' } } } },
      { name: 'get_team', description: 'Find a team by name', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: 'mcp_linear_list_issues',
      skill: 'linear',
      summary: 'List issues in a cycle',
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    });
  });

  test('applies include glob filter', () => {
    const mcpTools = [
      { name: 'list_issues', inputSchema: { type: 'object' } },
      { name: 'delete_issue', inputSchema: { type: 'object' } },
    ];
    const result = buildMcpCatalogTools({ skill: 'linear', server: 'linear', tools: mcpTools, include: ['list_*'] });
    expect(result.map(r => r.name)).toEqual(['mcp_linear_list_issues']);
  });

  test('falls back to name when description is missing', () => {
    const mcpTools = [{ name: 'ping', inputSchema: { type: 'object' } }];
    const result = buildMcpCatalogTools({ skill: 'demo', server: 'demo', tools: mcpTools });
    expect(result[0].summary).toBe('ping');
  });
});
