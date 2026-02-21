import { describe, test, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys } from '../../src/agent/tool-catalog.js';

describe('tool-catalog', () => {
  test('exports exactly 14 tools', () => {
    expect(TOOL_CATALOG.length).toBe(14);
  });

  test('TOOL_NAMES matches TOOL_CATALOG names', () => {
    expect(TOOL_NAMES).toEqual(TOOL_CATALOG.map(s => s.name));
  });

  test('all tool names are unique', () => {
    const unique = new Set(TOOL_NAMES);
    expect(unique.size).toBe(TOOL_NAMES.length);
  });

  test('every tool has name, label, description, and parameters', () => {
    for (const spec of TOOL_CATALOG) {
      expect(spec.name).toBeTruthy();
      expect(spec.label).toBeTruthy();
      expect(spec.description).toBeTruthy();
      expect(spec.parameters).toBeDefined();
    }
  });

  test('only user_write has injectUserId', () => {
    const withInject = TOOL_CATALOG.filter(s => s.injectUserId);
    expect(withInject.length).toBe(1);
    expect(withInject[0].name).toBe('user_write');
  });

  test('getToolParamKeys returns correct keys for memory_write', () => {
    const keys = getToolParamKeys('memory_write');
    expect(keys).toEqual(['scope', 'content', 'tags']);
  });

  test('getToolParamKeys returns correct keys for web_fetch', () => {
    const keys = getToolParamKeys('web_fetch');
    expect(keys).toEqual(['url', 'method', 'headers', 'timeoutMs']);
  });

  test('getToolParamKeys returns correct keys for scheduler_list_jobs (empty params)', () => {
    const keys = getToolParamKeys('scheduler_list_jobs');
    expect(keys).toEqual([]);
  });

  test('getToolParamKeys throws for unknown tool', () => {
    expect(() => getToolParamKeys('nonexistent')).toThrow('Unknown tool: nonexistent');
  });

  test('contains all expected tool names', () => {
    const expected = [
      'memory_write', 'memory_query', 'memory_read', 'memory_delete', 'memory_list',
      'web_fetch', 'web_search',
      'audit_query',
      'identity_write', 'user_write',
      'scheduler_add_cron', 'scheduler_run_at', 'scheduler_remove_cron', 'scheduler_list_jobs',
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });
});
