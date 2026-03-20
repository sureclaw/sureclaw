import { describe, test, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys, normalizeOrigin, normalizeIdentityFile, filterTools } from '../../src/agent/tool-catalog.js';
import type { ToolFilterContext, ToolCategory } from '../../src/agent/tool-catalog.js';

describe('tool-catalog', () => {
  test('exports exactly 16 tools', () => {
    expect(TOOL_CATALOG.length).toBe(16);
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

  test('only identity has injectUserId', () => {
    const withInject = TOOL_CATALOG.filter(s => s.injectUserId);
    expect(withInject.length).toBe(1);
    expect(withInject[0].name).toBe('identity');
  });

  test('getToolParamKeys returns correct keys for memory (union)', () => {
    const keys = getToolParamKeys('memory');
    expect(keys.sort()).toEqual(['content', 'id', 'limit', 'query', 'scope', 'tags']);
  });

  test('getToolParamKeys returns correct keys for web (union)', () => {
    const keys = getToolParamKeys('web');
    expect(keys.sort()).toEqual(['headers', 'maxResults', 'method', 'query', 'timeoutMs', 'url']);
  });

  test('getToolParamKeys returns correct keys for audit (singleton, direct object)', () => {
    const keys = getToolParamKeys('audit');
    expect(keys.sort()).toEqual(['action', 'limit', 'sessionId']);
  });

  test('getToolParamKeys throws for unknown tool', () => {
    expect(() => getToolParamKeys('nonexistent')).toThrow('Unknown tool: nonexistent');
  });

  test('contains all expected tool names', () => {
    const expected = [
      'memory', 'web', 'identity', 'scheduler', 'skill',
      'workspace_write', 'workspace_mount', 'governance', 'audit', 'agent', 'image',
      'web_approve', 'bash', 'read_file', 'write_file', 'edit_file',
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });

  test('workspace_write tool exists with singleton action', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'workspace_write');
    expect(spec).toBeDefined();
    expect(spec!.singletonAction).toBe('workspace_write');
    expect(spec!.category).toBe('workspace');
  });

  test('skill tool exists in catalog', () => {
    const skillTool = TOOL_CATALOG.find(t => t.name === 'skill');
    expect(skillTool).toBeDefined();
    expect(skillTool!.actionMap).toBeDefined();
    expect(Object.keys(skillTool!.actionMap!).sort()).toEqual([
      'download', 'request_credential', 'search',
    ]);
  });

  test('skill tool has correct param keys', () => {
    const keys = getToolParamKeys('skill');
    expect(keys.sort()).toEqual(['envName', 'limit', 'query', 'slug']);
  });

  test('scheduler tool has correct param keys (union of all members)', () => {
    const keys = getToolParamKeys('scheduler');
    expect(keys.sort()).toEqual(['datetime', 'jobId', 'maxTokenBudget', 'prompt', 'schedule']);
  });

  // Regression: weaker models (Gemini, Kimi) send free-text for enum fields,
  // causing AJV validateToolArguments to reject before execute() runs.
  // The tool schemas now use Type.String() and normalization coerces values.
  test('identity tool union members use String type for origin (not enum)', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'identity')!;
    // Identity is a union — check each member that has an origin field
    const schema = spec.parameters as any;
    expect(schema.anyOf).toBeDefined();
    for (const member of schema.anyOf) {
      if (member.properties.origin) {
        expect(member.properties.origin.type, `identity member origin should be "string" type`).toBe('string');
        expect(member.properties.origin.anyOf, `identity member origin should not have anyOf (enum)`).toBeUndefined();
      }
    }
  });

  test('identity write member uses String type for file (not enum)', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'identity')!;
    const schema = spec.parameters as any;
    // Find the 'write' member (has a 'file' property)
    const writeMember = schema.anyOf.find((m: any) =>
      m.properties.type?.const === 'write' && m.properties.file
    );
    expect(writeMember).toBeDefined();
    expect(writeMember.properties.file.type, 'identity write member file should be "string" type').toBe('string');
  });

  test('every tool has a valid category', () => {
    const validCategories: ToolCategory[] = [
      'memory', 'web', 'audit', 'identity',
      'scheduler', 'skill', 'delegation', 'image',
      'workspace', 'workspace_scopes', 'governance', 'sandbox',
    ];
    for (const spec of TOOL_CATALOG) {
      expect(validCategories, `"${spec.name}" has invalid category "${spec.category}"`).toContain(spec.category);
    }
  });

  test('every category has at least one tool', () => {
    const categories: ToolCategory[] = [
      'memory', 'web', 'audit', 'identity',
      'scheduler', 'skill', 'delegation', 'image',
      'workspace', 'workspace_scopes', 'governance', 'sandbox',
    ];
    for (const cat of categories) {
      const tools = TOOL_CATALOG.filter(s => s.category === cat);
      expect(tools.length, `category "${cat}" has no tools`).toBeGreaterThan(0);
    }
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

// ── filterTools ────────────────────────────────────────────────────────

describe('filterTools', () => {
  const ALL_FLAGS: ToolFilterContext = {
    hasHeartbeat: true,
    hasSkills: true,
    hasWorkspaceScopes: true,
    hasGovernance: true,
  };

  const NO_FLAGS: ToolFilterContext = {
    hasHeartbeat: false,
    hasSkills: false,
    hasWorkspaceScopes: false,
    hasGovernance: false,
  };

  test('all flags true returns full catalog', () => {
    const result = filterTools(ALL_FLAGS);
    expect(result.length).toBe(TOOL_CATALOG.length);
  });

  test('all flags false returns only always-on categories', () => {
    const result = filterTools(NO_FLAGS);
    // skill tools are always on, so only scheduler/workspace/governance are excluded
    const alwaysOn = TOOL_CATALOG.filter(s =>
      !['scheduler', 'workspace', 'workspace_scopes', 'governance'].includes(s.category)
    );
    expect(result.length).toBe(alwaysOn.length);

    // Verify excluded categories (skill is NOT excluded)
    for (const spec of result) {
      expect(['scheduler', 'workspace', 'workspace_scopes', 'governance']).not.toContain(spec.category);
    }
  });

  test('hasHeartbeat includes scheduler tool', () => {
    const result = filterTools({ ...NO_FLAGS, hasHeartbeat: true });
    const names = result.map(s => s.name);
    expect(names).toContain('scheduler');
  });

  test('hasHeartbeat=false excludes scheduler tool', () => {
    const result = filterTools({ ...ALL_FLAGS, hasHeartbeat: false });
    const names = result.map(s => s.name);
    expect(names).not.toContain('scheduler');
  });

  test('skill tools are always available regardless of hasSkills', () => {
    const withSkills = filterTools({ ...NO_FLAGS, hasSkills: true });
    const withoutSkills = filterTools({ ...NO_FLAGS, hasSkills: false });
    expect(withSkills.map(s => s.name)).toContain('skill');
    expect(withoutSkills.map(s => s.name)).toContain('skill');
  });

  test('hasGovernance includes governance tool', () => {
    const result = filterTools({ ...NO_FLAGS, hasGovernance: true });
    const names = result.map(s => s.name);
    expect(names).toContain('governance');
  });

  test('hasGovernance=false excludes governance tool', () => {
    const result = filterTools({ ...ALL_FLAGS, hasGovernance: false });
    const names = result.map(s => s.name);
    expect(names).not.toContain('governance');
  });

  test('core tools are always present regardless of flags', () => {
    const result = filterTools(NO_FLAGS);
    const names = result.map(s => s.name);
    // Memory
    expect(names).toContain('memory');
    // Web
    expect(names).toContain('web');
    // Audit
    expect(names).toContain('audit');
    // Identity
    expect(names).toContain('identity');
    // Delegation
    expect(names).toContain('agent');
  });
});
