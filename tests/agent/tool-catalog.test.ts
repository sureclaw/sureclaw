import { describe, test, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys, normalizeOrigin, normalizeIdentityFile } from '../../src/agent/tool-catalog.js';

describe('tool-catalog', () => {
  test('exports exactly 23 tools', () => {
    expect(TOOL_CATALOG.length).toBe(23);
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
      'skill_list', 'skill_read', 'skill_propose',
      // Enterprise tools
      'workspace_write', 'workspace_read', 'workspace_list',
      'identity_propose', 'proposal_list', 'agent_registry_list',
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });

  test('skill tools exist in catalog', () => {
    const skillTools = TOOL_CATALOG.filter(t => t.name.startsWith('skill_'));
    expect(skillTools.map(t => t.name).sort()).toEqual([
      'skill_list', 'skill_propose', 'skill_read',
    ]);
  });

  test('skill_propose has correct params', () => {
    const keys = getToolParamKeys('skill_propose');
    expect(keys.sort()).toEqual(['content', 'reason', 'skill']);
  });

  test('skill_read has correct params', () => {
    const keys = getToolParamKeys('skill_read');
    expect(keys).toEqual(['name']);
  });

  test('skill_list has no params', () => {
    const keys = getToolParamKeys('skill_list');
    expect(keys).toEqual([]);
  });

  // Regression: weaker models (Gemini, Kimi) send free-text for enum fields,
  // causing AJV validateToolArguments to reject before execute() runs.
  // The tool schemas now use Type.String() and normalization coerces values.
  test('identity_write and user_write use String type for origin (not enum)', () => {
    for (const name of ['identity_write', 'user_write']) {
      const spec = TOOL_CATALOG.find(s => s.name === name)!;
      const originSchema = (spec.parameters as any).properties.origin;
      // Should be a plain string schema, NOT a union of literals
      expect(originSchema.type, `${name}.origin should be "string" type`).toBe('string');
      expect(originSchema.anyOf, `${name}.origin should not have anyOf (enum)`).toBeUndefined();
    }
  });

  test('identity_write uses String type for file (not enum)', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'identity_write')!;
    const fileSchema = (spec.parameters as any).properties.file;
    expect(fileSchema.type, 'identity_write.file should be "string" type').toBe('string');
  });
});

describe('normalizeOrigin', () => {
  test('passes through exact enum values', () => {
    expect(normalizeOrigin('user_request')).toBe('user_request');
    expect(normalizeOrigin('agent_initiated')).toBe('agent_initiated');
  });

  test('normalizes free-text that contains the enum value', () => {
    expect(normalizeOrigin('This is a user_request because...')).toBe('user_request');
    expect(normalizeOrigin('agent_initiated by me')).toBe('agent_initiated');
  });

  test('normalizes hyphenated variants', () => {
    expect(normalizeOrigin('user-request')).toBe('user_request');
    expect(normalizeOrigin('agent-initiated')).toBe('agent_initiated');
  });

  test('defaults to user_request for unrecognized free text', () => {
    expect(normalizeOrigin('The user felt too moody so I changed it')).toBe('user_request');
    expect(normalizeOrigin('because reasons')).toBe('user_request');
    expect(normalizeOrigin('')).toBe('user_request');
  });

  test('handles non-string values', () => {
    expect(normalizeOrigin(undefined)).toBe('user_request');
    expect(normalizeOrigin(null)).toBe('user_request');
    expect(normalizeOrigin(42)).toBe('user_request');
  });
});

describe('normalizeIdentityFile', () => {
  test('passes through exact file names', () => {
    expect(normalizeIdentityFile('SOUL.md')).toBe('SOUL.md');
    expect(normalizeIdentityFile('IDENTITY.md')).toBe('IDENTITY.md');
  });

  test('normalizes case variations', () => {
    expect(normalizeIdentityFile('soul.md')).toBe('SOUL.md');
    expect(normalizeIdentityFile('Soul.md')).toBe('SOUL.md');
    expect(normalizeIdentityFile('identity.md')).toBe('IDENTITY.md');
    expect(normalizeIdentityFile('Identity.md')).toBe('IDENTITY.md');
  });

  test('normalizes names without extension', () => {
    expect(normalizeIdentityFile('soul')).toBe('SOUL.md');
    expect(normalizeIdentityFile('identity')).toBe('IDENTITY.md');
  });

  test('returns raw value for unrecognized names', () => {
    expect(normalizeIdentityFile('USER.md')).toBe('USER.md');
    expect(normalizeIdentityFile('random')).toBe('random');
  });
});
