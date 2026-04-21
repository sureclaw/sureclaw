import { describe, test, expect, beforeEach } from 'vitest';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';
import type { CatalogTool } from '../../../src/host/tool-catalog/types.js';

const toolA: CatalogTool = {
  name: 'mcp_linear_list_issues',
  skill: 'linear',
  summary: 'List issues',
  schema: { type: 'object' },
  dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
};

describe('ToolCatalog', () => {
  let catalog: ToolCatalog;
  beforeEach(() => {
    catalog = new ToolCatalog();
  });

  test('registers and retrieves a tool by name', () => {
    catalog.register(toolA);
    expect(catalog.get('mcp_linear_list_issues')).toEqual(toolA);
  });

  test('rejects duplicate names', () => {
    catalog.register(toolA);
    expect(() => catalog.register(toolA)).toThrow(/already registered/);
  });

  test('lists all tools in insertion order', () => {
    catalog.register(toolA);
    catalog.register({
      ...toolA,
      name: 'mcp_linear_get_team',
      dispatch: { ...toolA.dispatch, toolName: 'get_team' },
    });
    expect(catalog.list().map((t) => t.name)).toEqual([
      'mcp_linear_list_issues',
      'mcp_linear_get_team',
    ]);
  });

  test('lists tools filtered by skill', () => {
    catalog.register(toolA);
    catalog.register({ ...toolA, name: 'mcp_stripe_foo', skill: 'stripe' });
    expect(catalog.listBySkill('linear').map((t) => t.name)).toEqual([
      'mcp_linear_list_issues',
    ]);
  });

  test('freeze prevents further registration', () => {
    catalog.register(toolA);
    catalog.freeze();
    expect(() => catalog.register({ ...toolA, name: 'mcp_other_x' })).toThrow(
      /frozen/,
    );
  });
});
