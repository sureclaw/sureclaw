/**
 * Tests for MCP CLI tool generation.
 */

import { describe, it, expect } from 'vitest';
import { groupToolsByServer, generateCLI, mcpToolToCLICommand } from '../../../src/host/toolgen/codegen.js';
import { initLogger } from '../../../src/logger.js';

initLogger({ file: false, level: 'silent' });

describe('groupToolsByServer', () => {
  it('should group by underscore prefix and strip prefix from name', () => {
    const groups = groupToolsByServer([
      { name: 'linear_getIssues', description: '', inputSchema: {} },
      { name: 'linear_getTeams', description: '', inputSchema: {} },
      { name: 'github_getRepo', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(2);
    const linear = groups.find(g => g.server === 'linear')!;
    expect(linear.tools).toHaveLength(2);
    expect(linear.tools.map(t => t.name)).toEqual(['getIssues', 'getTeams']);
    expect(groups.find(g => g.server === 'github')?.tools[0].name).toBe('getRepo');
  });

  it('should group by slash prefix and strip prefix from name', () => {
    const groups = groupToolsByServer([
      { name: 'linear/getIssues', description: '', inputSchema: {} },
      { name: 'linear/getTeams', description: '', inputSchema: {} },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].server).toBe('linear');
    expect(groups[0].tools.map(t => t.name)).toEqual(['getIssues', 'getTeams']);
  });

  it('should put unprefixed tools in default without stripping', () => {
    const groups = groupToolsByServer([
      { name: 'search', description: '', inputSchema: {} },
    ]);
    expect(groups[0].server).toBe('default');
    expect(groups[0].tools[0].name).toBe('search');
  });
});

describe('mcpToolToCLICommand', () => {
  it('converts list_issues → list-issues', () => {
    expect(mcpToolToCLICommand('list_issues')).toBe('list-issues');
  });
  it('converts get_team → get-team', () => {
    expect(mcpToolToCLICommand('get_team')).toBe('get-team');
  });
  it('converts save_customer_need → save-customer-need', () => {
    expect(mcpToolToCLICommand('save_customer_need')).toBe('save-customer-need');
  });
  it('converts get_authenticated_user → get-authenticated-user', () => {
    expect(mcpToolToCLICommand('get_authenticated_user')).toBe('get-authenticated-user');
  });
});

describe('generateCLI', () => {
  it('generates a valid JS file with kebab-case commands', () => {
    const result = generateCLI('linear', [
      { name: 'list_issues', description: 'List issues', inputSchema: { type: 'object', properties: { team: { type: 'string' }, limit: { type: 'number' } } } },
      { name: 'get_issue', description: 'Get issue by ID', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
    ]);
    expect(result).toMatch(/^#!\/usr\/bin\/env node\n/);
    expect(result).toContain('"list-issues"');
    expect(result).toContain('"get-issue"');
    expect(result).toContain('list_issues');
    expect(result).toContain('"team"');
    expect(result).toContain('"limit"');
    expect(result).toContain('"id"');
    expect(result).toContain('"Issues"');
  });

  it('includes IPC client using fetch', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
    ]);
    expect(result).toContain('AX_HOST_URL');
    expect(result).toContain('AX_IPC_TOKEN');
    expect(result).toContain('/internal/ipc');
    expect(result).toContain('tool_batch');
  });

  it('handles stdin piping', () => {
    const result = generateCLI('linear', [
      { name: 'list_teams', description: 'List teams', inputSchema: { type: 'object', properties: {} } },
    ]);
    expect(result).toContain('stdin');
    expect(result).toContain('JSON.parse');
  });
});
