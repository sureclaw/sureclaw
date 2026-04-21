import { describe, test, expect } from 'vitest';
import { validateCatalogTool } from '../../../src/host/tool-catalog/types.js';

describe('CatalogTool validation', () => {
  test('accepts a minimal MCP catalog tool', () => {
    const tool = {
      name: 'mcp_linear_list_issues',
      skill: 'linear',
      summary: 'List Linear issues',
      schema: { type: 'object', properties: { team: { type: 'string' } } },
      dispatch: { kind: 'mcp' as const, server: 'linear', toolName: 'list_issues' },
    };
    expect(() => validateCatalogTool(tool)).not.toThrow();
  });

  test('rejects a tool without a name', () => {
    expect(() => validateCatalogTool({ skill: 'linear' })).toThrow(/name/);
  });

  test('rejects unknown dispatch kinds', () => {
    const bad = {
      name: 'foo', skill: 'x', summary: 's',
      schema: { type: 'object' },
      dispatch: { kind: 'bogus', target: 'nope' },
    };
    expect(() => validateCatalogTool(bad as never)).toThrow(/dispatch/);
  });
});
