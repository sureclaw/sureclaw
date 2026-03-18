// tests/agent/prompt/modules/skills.test.ts
import { describe, test, expect } from 'vitest';
import { SkillsModule } from '../../../../src/agent/prompt/modules/skills.js';
import type { PromptContext, SkillSummary } from '../../../../src/agent/prompt/types.js';

function makeSkill(name: string, description: string, path?: string): SkillSummary {
  return { name, description, path: path ?? `${name.toLowerCase().replace(/\s+/g, '-')}.md` };
}

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp',
    skills: [],
    profile: 'paranoid',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('SkillsModule', () => {
  test('not included when no skills', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext())).toBe(false);
  });

  test('included when skills present', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext({ skills: [makeSkill('Safety', 'Be safe')] }))).toBe(true);
  });

  test('renders compact skill table instead of full content', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [
        makeSkill('Daily Standup', 'Generates daily standup summaries'),
        makeSkill('Code Review', 'Reviews pull requests for quality'),
      ],
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('Available Skills');
    expect(text).toContain('| Daily Standup | Generates daily standup summaries |');
    expect(text).toContain('| Code Review | Reviews pull requests for quality |');
    // Should NOT contain full skill content — only compact table
    // References consolidated skill tool with type: "read"
    expect(text).toContain('skill');
    expect(text).toContain('read');
  });

  test('priority is 70', () => {
    const mod = new SkillsModule();
    expect(mod.priority).toBe(70);
  });

  test('includes filesystem-based skill creation instructions', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('./user/skills/');
  });

  test('includes next-session hint', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('next session');
  });

  test('includes creating skills section', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('Creating Skills');
  });

  test('includes progressive disclosure guidance', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test', 'Desc')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('Never read more than one skill up front');
    expect(rendered).toContain('scan this list');
  });

  test('renderMinimal shows skill count', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [makeSkill('A', 'a'), makeSkill('B', 'b'), makeSkill('C', 'c')],
    });
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('3 skills available');
    expect(text).toContain('skill');
    expect(text).toContain('Read');
  });
});
