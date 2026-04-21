import { describe, test, expect } from 'vitest';
import { renderCatalogOneLiners } from '../../../src/host/tool-catalog/render.js';
import { ToolCatalog } from '../../../src/host/tool-catalog/registry.js';

describe('renderCatalogOneLiners', () => {
  test('groups tools by skill and renders one-liners', () => {
    const catalog = new ToolCatalog();
    catalog.register({
      name: 'mcp_linear_list_issues', skill: 'linear', summary: 'List issues',
      schema: { type: 'object', properties: { team: { type: 'string' }, state: { type: 'string' } }, required: ['team'] },
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'list_issues' },
    });
    catalog.register({
      name: 'mcp_linear_get_team', skill: 'linear', summary: 'Find a team',
      schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      dispatch: { kind: 'mcp', server: 'linear', toolName: 'get_team' },
    });
    const out = renderCatalogOneLiners(catalog);
    expect(out).toContain('### linear');
    // `_select?` is now advertised alongside real tool params — the jq
    // projection is wired through in call-tool.ts (Task 4.2).
    expect(out).toContain('- mcp_linear_list_issues(team, state?, _select?) — List issues');
    expect(out).toContain('- mcp_linear_get_team(query, _select?) — Find a team');
  });

  test('returns empty string for empty catalog', () => {
    expect(renderCatalogOneLiners(new ToolCatalog())).toBe('');
  });
});
