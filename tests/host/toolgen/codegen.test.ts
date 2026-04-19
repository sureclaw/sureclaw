/**
 * Tests for MCP tool codegen grouping.
 */

import { describe, it, expect } from 'vitest';
import { groupToolsByServer } from '../../../src/host/toolgen/codegen.js';
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
