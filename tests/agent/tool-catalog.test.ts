import { describe, test, expect } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, getToolParamKeys, filterTools } from '../../src/agent/tool-catalog.js';
import type { ToolFilterContext, ToolCategory } from '../../src/agent/tool-catalog.js';

describe('tool-catalog', () => {
  test('exports exactly 15 tools', () => {
    expect(TOOL_CATALOG.length).toBe(15);
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

  test('no tools have injectUserId (identity tool removed)', () => {
    const withInject = TOOL_CATALOG.filter(s => s.injectUserId);
    expect(withInject.length).toBe(0);
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
      'memory', 'web', 'scheduler', 'skill', 'request_credential',
      'save_artifact',
      'audit', 'agent',
      'bash', 'read_file', 'write_file', 'edit_file',
      'grep', 'glob', 'execute_script',
    ];
    expect(TOOL_NAMES).toEqual(expected);
  });

  test('save_artifact tool exists with singleton action', () => {
    const spec = TOOL_CATALOG.find(s => s.name === 'save_artifact');
    expect(spec).toBeDefined();
    expect(spec!.singletonAction).toBe('save_artifact');
    expect(spec!.category).toBe('workspace');
  });

  test('skill tool exists in catalog with actionMap', () => {
    const skillTool = TOOL_CATALOG.find(t => t.name === 'skill');
    expect(skillTool).toBeDefined();
    expect(skillTool!.actionMap).toBeDefined();
    expect(skillTool!.actionMap!.install).toBe('skill_install');
    expect(skillTool!.actionMap!.update).toBe('skill_update');
    expect(skillTool!.actionMap!.delete).toBe('skill_delete');
  });

  test('skill tool has correct param keys', () => {
    const keys = getToolParamKeys('skill');
    expect(keys.sort()).toEqual(['content', 'path', 'query', 'slug']);
  });

  test('skill install variants each require slug or query (not both optional)', () => {
    const skillTool = TOOL_CATALOG.find(t => t.name === 'skill')!;
    const schema = skillTool.parameters as any;
    const installVariants = schema.anyOf.filter(
      (v: any) => v.properties?.type?.const === 'install',
    );
    // Should have two install variants: one with required slug, one with required query
    expect(installVariants.length).toBe(2);
    const hasSlugRequired = installVariants.some(
      (v: any) => v.required?.includes('slug') && !v.required?.includes('query'),
    );
    const hasQueryRequired = installVariants.some(
      (v: any) => v.required?.includes('query') && !v.required?.includes('slug'),
    );
    expect(hasSlugRequired).toBe(true);
    expect(hasQueryRequired).toBe(true);
  });

  test('request_credential tool exists in catalog as singleton', () => {
    const credTool = TOOL_CATALOG.find(t => t.name === 'request_credential');
    expect(credTool).toBeDefined();
    expect(credTool!.singletonAction).toBe('credential_request');
    expect(credTool!.category).toBe('credential');
  });

  test('scheduler tool has correct param keys (union of all members)', () => {
    const keys = getToolParamKeys('scheduler');
    expect(keys.sort()).toEqual(['datetime', 'id', 'maxTokenBudget', 'prompt', 'schedule']);
  });

  test('every tool has a valid category', () => {
    const validCategories: ToolCategory[] = [
      'memory', 'web', 'audit',
      'scheduler', 'skill', 'credential', 'delegation',
      'workspace', 'sandbox',
    ];
    for (const spec of TOOL_CATALOG) {
      expect(validCategories, `"${spec.name}" has invalid category "${spec.category}"`).toContain(spec.category);
    }
  });

  test('every category has at least one tool', () => {
    const categories: ToolCategory[] = [
      'memory', 'web', 'audit',
      'scheduler', 'skill', 'credential', 'delegation',
      'workspace', 'sandbox',
    ];
    for (const cat of categories) {
      const tools = TOOL_CATALOG.filter(s => s.category === cat);
      expect(tools.length, `category "${cat}" has no tools`).toBeGreaterThan(0);
    }
  });
});

// ── filterTools ────────────────────────────────────────────────────────

describe('filterTools', () => {
  const ALL_FLAGS: ToolFilterContext = {
    hasHeartbeat: true,
    skillInstallEnabled: true,
  };

  const NO_FLAGS: ToolFilterContext = {
    hasHeartbeat: false,
    skillInstallEnabled: false,
  };

  test('all flags true returns full catalog', () => {
    const result = filterTools(ALL_FLAGS);
    expect(result.length).toBe(TOOL_CATALOG.length);
  });

  test('all flags false returns only always-on categories', () => {
    const result = filterTools(NO_FLAGS);
    // All tools are always-on now (governance removed)
    expect(result.length).toBe(TOOL_CATALOG.length);
  });

  test('scheduler tool is always present regardless of hasHeartbeat', () => {
    const result = filterTools(NO_FLAGS);
    const names = result.map(s => s.name);
    expect(names).toContain('scheduler');
  });

  test('skillInstallEnabled=true includes skill tool with install action', () => {
    const result = filterTools({ ...NO_FLAGS, skillInstallEnabled: true });
    const skill = result.find(s => s.name === 'skill');
    expect(skill).toBeDefined();
    expect(skill!.actionMap).toHaveProperty('install');
    // Schema should contain install variants
    const schema = skill!.parameters as any;
    const installVariants = schema.anyOf.filter(
      (v: any) => v.properties?.type?.const === 'install',
    );
    expect(installVariants.length).toBeGreaterThan(0);
  });

  test('skill tool always present regardless of skillInstallEnabled flag', () => {
    const result = filterTools({ ...NO_FLAGS, skillInstallEnabled: false });
    expect(result.map(s => s.name)).toContain('skill');
    expect(result.map(s => s.name)).toContain('request_credential');
  });

  test('skillInstallEnabled=false strips install variants from skill tool', () => {
    const result = filterTools({ ...NO_FLAGS, skillInstallEnabled: false });
    const skill = result.find(s => s.name === 'skill');
    expect(skill).toBeDefined();
    // actionMap should not contain install
    expect(skill!.actionMap).not.toHaveProperty('install');
    // create/update/delete should remain
    expect(skill!.actionMap).toHaveProperty('create');
    expect(skill!.actionMap).toHaveProperty('update');
    expect(skill!.actionMap).toHaveProperty('delete');
    // Schema should not contain install variants
    const schema = skill!.parameters as any;
    const installVariants = schema.anyOf.filter(
      (v: any) => v.properties?.type?.const === 'install',
    );
    expect(installVariants.length).toBe(0);
    // Description should not advertise install as an available type
    expect(skill!.description).not.toMatch(/- install:/);
    expect(skill!.description).not.toMatch(/Create, install,/);
  });

  test('skillInstallEnabled undefined defaults to including skill tool without install', () => {
    const ctx: ToolFilterContext = { hasHeartbeat: false };
    const result = filterTools(ctx);
    const skill = result.find(s => s.name === 'skill');
    expect(skill).toBeDefined();
    // undefined skillInstallEnabled should strip install (falsy)
    expect(skill!.actionMap).not.toHaveProperty('install');
  });

  test('request_credential is always present regardless of flags', () => {
    const result = filterTools(NO_FLAGS);
    expect(result.map(s => s.name)).toContain('request_credential');
  });

  test('core tools are always present regardless of flags', () => {
    const result = filterTools(NO_FLAGS);
    const names = result.map(s => s.name);
    expect(names).toContain('memory');
    expect(names).toContain('web');
    expect(names).toContain('audit');
    expect(names).toContain('agent');
  });
});
