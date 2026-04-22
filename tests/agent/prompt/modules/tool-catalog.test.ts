// tests/agent/prompt/modules/tool-catalog.test.ts
import { describe, test, expect } from 'vitest';
import { ToolCatalogModule, makeToolCatalogModule } from '../../../../src/agent/prompt/modules/tool-catalog.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';
import type { CatalogTool } from '../../../../src/types/catalog.js';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp',
    skills: [],
    profile: 'balanced',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.30,
    identityFiles: { agents: '', soul: 'Test soul.', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

function sampleTool(overrides: Partial<CatalogTool> = {}): CatalogTool {
  return {
    name: 'mcp_linear_x',
    skill: 'linear',
    summary: 's',
    schema: { type: 'object' },
    dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' },
    ...overrides,
  };
}

describe('ToolCatalogModule', () => {
  test('renders Available tools section when catalog is present', () => {
    const ctx = makeCtx({ catalog: [sampleTool()] });
    const module = makeToolCatalogModule();
    const out = module.render(ctx).join('\n');
    expect(out).toContain('mcp_linear_x');
    expect(out).toContain('## Available tools');
    expect(out).toContain('### linear');
  });

  test('renders empty array of lines when catalog is empty', () => {
    const ctx = makeCtx({ catalog: [] });
    expect(makeToolCatalogModule().render(ctx)).toEqual([]);
  });

  test('renders empty array of lines when catalog is missing', () => {
    // No catalog key at all on the context — simulates agents whose host
    // didn't ship a catalog (e.g. non-session runners or legacy runs).
    const ctx = makeCtx();
    expect(makeToolCatalogModule().render(ctx)).toEqual([]);
  });

  test('shouldInclude is false when catalog is missing or empty', () => {
    const mod = makeToolCatalogModule();
    expect(mod.shouldInclude(makeCtx())).toBe(false);
    expect(mod.shouldInclude(makeCtx({ catalog: [] }))).toBe(false);
  });

  test('shouldInclude is true when catalog has at least one tool', () => {
    const mod = makeToolCatalogModule();
    expect(mod.shouldInclude(makeCtx({ catalog: [sampleTool()] }))).toBe(true);
  });

  test('groups multiple skills under their own headers', () => {
    const ctx = makeCtx({
      catalog: [
        sampleTool({ name: 'mcp_linear_list_issues', skill: 'linear', summary: 'List issues', schema: { type: 'object', properties: { team: { type: 'string' } }, required: ['team'] } }),
        sampleTool({ name: 'mcp_github_list_repos', skill: 'github', summary: 'List repos', schema: { type: 'object' }, dispatch: { kind: 'mcp', server: 'github', toolName: 'list_repos' } }),
      ],
    });
    const out = makeToolCatalogModule().render(ctx).join('\n');
    expect(out).toContain('### linear');
    expect(out).toContain('### github');
    // `_select?` is appended to every tool's params — the jq projection
    // knob is wired through in call-tool.ts (Task 4.2). See catalog-render.ts.
    expect(out).toContain('mcp_linear_list_issues(team, _select?)');
    expect(out).toContain('mcp_github_list_repos(_select?)');
  });

  test('priority is 92 (after runtime, before reply-gate)', () => {
    const mod = new ToolCatalogModule();
    expect(mod.priority).toBe(92);
  });

  test('is optional (droppable under budget pressure)', () => {
    const mod = new ToolCatalogModule();
    expect(mod.optional).toBe(true);
  });

  test('factory returns a ToolCatalogModule instance', () => {
    expect(makeToolCatalogModule()).toBeInstanceOf(ToolCatalogModule);
  });

  // The usage note teaches the LLM to dispatch via the two meta-tools
  // (describe_tools + call_tool). No CLI shim model, no ax.callTool
  // scripting helper — those were both tried and both retired.
  test('appends the meta-tool usage note when the catalog renders', () => {
    const ctx = makeCtx({ catalog: [{ ...sampleTool(), name: 'mcp_linear_get_team' }] });
    const out = makeToolCatalogModule().render(ctx).join('\n');
    expect(out).toContain('### Calling catalog tools');
    expect(out).toContain('describe_tools');
    expect(out).toContain('call_tool');
  });

  test('does NOT mention retired dispatch helpers in the usage note', () => {
    // Scope: the "### Calling catalog tools" section. We assemble the
    // retired tool name from parts so this file stays clean of the literal
    // string (execute_script grep invariant).
    const retiredTool = ['execute', 'script'].join('_');
    const ctx = makeCtx({ catalog: [{ ...sampleTool(), name: 'mcp_linear_get_team' }] });
    const lines = makeToolCatalogModule().render(ctx);
    const noteStart = lines.findIndex((l) => l.startsWith('### Calling catalog tools'));
    expect(noteStart).toBeGreaterThanOrEqual(0);
    const note = lines.slice(noteStart).join('\n');
    expect(note).not.toContain(retiredTool);
    expect(note).not.toContain('ax.callTool');
    expect(note).not.toContain('--stdin-args');
    expect(note).not.toContain('busybox');
  });

  test('does NOT append the usage note when the catalog is empty', () => {
    // The note lives under `## Available tools`; an empty catalog still
    // drops the whole module, so the note must not leak as an orphan
    // section somewhere else in the prompt.
    const ctx = makeCtx({ catalog: [] });
    const out = makeToolCatalogModule().render(ctx).join('\n');
    expect(out).not.toContain('### Calling catalog tools');
  });

  test('instructs the agent to surface missing-tool gaps instead of papering over them', () => {
    // After the petstore hallucination incident (agent invented a replacement
    // MCP skill via skill_write when it couldn't find api_petstore_* tools),
    // the prompt now requires the agent to REPORT gaps explicitly rather
    // than guess or fabricate. This test pins the three specific anti-patterns
    // the guidance calls out: invented tool names, fabricated replacement
    // skills, and silent workarounds.
    const ctx = makeCtx({ catalog: [{ ...sampleTool(), name: 'mcp_linear_get_team' }] });
    const out = makeToolCatalogModule().render(ctx).join('\n');
    expect(out).toContain('### When an expected tool is missing');
    expect(out).toMatch(/report the gap explicitly/i);
    expect(out).toMatch(/do NOT.*invent tool names/i);
    expect(out).toMatch(/do NOT.*fabricate a replacement skill/i);
    expect(out).toContain('skill_write');
  });
});
