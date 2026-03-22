// tests/agent/prompt/modules/skills.test.ts
import { describe, test, expect } from 'vitest';
import { SkillsModule, detectSkillInstallIntent } from '../../../../src/agent/prompt/modules/skills.js';
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

describe('detectSkillInstallIntent', () => {
  test('returns true for "install the linear skill"', () => {
    expect(detectSkillInstallIntent('install the linear skill')).toBe(true);
  });

  test('returns true for "find a plugin for slack"', () => {
    expect(detectSkillInstallIntent('find a plugin for slack')).toBe(true);
  });

  test('returns true for clawhub URL reference', () => {
    expect(detectSkillInstallIntent('check out clawhub.ai/Author/skill')).toBe(true);
  });

  test('returns true for "add the jira integration"', () => {
    expect(detectSkillInstallIntent('add the jira integration')).toBe(true);
  });

  test('returns true for "are there any skills for project management?"', () => {
    expect(detectSkillInstallIntent('are there any skills for project management?')).toBe(true);
  });

  test('returns true for "do you have a plugin for github?"', () => {
    expect(detectSkillInstallIntent('do you have a plugin for github?')).toBe(true);
  });

  test('returns true for "search for a tool to manage tasks"', () => {
    expect(detectSkillInstallIntent('search for a tool to manage tasks')).toBe(true);
  });

  test('returns false for "use the linear skill"', () => {
    expect(detectSkillInstallIntent('use the linear skill')).toBe(false);
  });

  test('returns false for "read the skill"', () => {
    expect(detectSkillInstallIntent('read the skill')).toBe(false);
  });

  test('returns false for "what can you do?"', () => {
    expect(detectSkillInstallIntent('what can you do?')).toBe(false);
  });

  test('returns false for empty message', () => {
    expect(detectSkillInstallIntent('')).toBe(false);
  });

  test('returns false for unrelated message', () => {
    expect(detectSkillInstallIntent('write a function that sorts an array')).toBe(false);
  });
});

describe('SkillsModule', () => {
  test('always included (even with no skills, for install guidance)', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('included when skills present', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext({ skills: [makeSkill('Safety', 'Be safe')] }))).toBe(true);
  });

  test('renders no-skills message when no skills loaded and install disabled', () => {
    const mod = new SkillsModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('No skills are currently installed');
    // Install instructions should NOT appear without skillInstallEnabled
    expect(text).not.toContain('Installing New Skills');
  });

  test('renders install instructions when skillInstallEnabled is true', () => {
    const mod = new SkillsModule();
    const text = mod.render(makeContext({ skillInstallEnabled: true })).join('\n');
    expect(text).toContain('Installing New Skills');
    expect(text).toContain('skill({ type: "install"');
    expect(text).toContain('request_credential');
  });

  test('does NOT render install instructions when skillInstallEnabled is false', () => {
    const mod = new SkillsModule();
    const text = mod.render(makeContext({ skillInstallEnabled: false })).join('\n');
    expect(text).not.toContain('Installing New Skills');
    expect(text).not.toContain('request_credential');
  });

  test('does NOT render install instructions when skillInstallEnabled is omitted', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [makeSkill('Test', 'Test skill')],
    });
    const text = mod.render(ctx).join('\n');
    expect(text).not.toContain('Installing New Skills');
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

  test('includes filesystem-based skill creation instructions when writable', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')], userWorkspaceWritable: true });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('./user/skills/');
  });

  test('omits skill creation when user workspace is not writable', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).not.toContain('Creating Skills');
  });

  test('includes next-session hint when writable', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')], userWorkspaceWritable: true });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('next session');
  });

  test('includes creating skills section when writable', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')], userWorkspaceWritable: true });
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

  test('renderMinimal with no skills shows simple message', () => {
    const mod = new SkillsModule();
    const ctx = makeContext();
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('No skills installed.');
    // Should NOT contain install instructions in minimal mode
    expect(text).not.toContain('Installing New Skills');
  });
});
