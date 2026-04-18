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
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: '', identity: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('SkillsModule', () => {
  test('always included (even with no skills)', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('included when skills present', () => {
    const mod = new SkillsModule();
    expect(mod.shouldInclude(makeContext({ skills: [makeSkill('Safety', 'Be safe')] }))).toBe(true);
  });

  test('renders no-skills message when no skills loaded', () => {
    const mod = new SkillsModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('No skills are currently installed');
  });

  test('renders bullet list of skills (design-doc format)', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [
        makeSkill('daily-standup', 'Generates daily standup summaries'),
        makeSkill('code-review', 'Reviews pull requests for quality'),
      ],
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('## Available skills');
    expect(text).toContain('- **daily-standup** — Generates daily standup summaries');
    expect(text).toContain('- **code-review** — Reviews pull requests for quality');
    expect(text).toContain('`.ax/skills/<name>/SKILL.md`');
  });

  test('renders bullet with pending reasons (design-doc format)', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [
        { name: 'linear', description: 'When the user wants to query or update Linear issues.', kind: 'pending', pendingReasons: ['needs LINEAR_TOKEN', 'awaiting approval for mcp.linear.app'] },
        { name: 'weather', description: 'When the user asks about weather conditions or forecasts.', kind: 'enabled' },
      ],
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('## Available skills');
    expect(text).toMatch(/- \*\*linear\*\* — \(setup pending: needs LINEAR_TOKEN, awaiting approval for mcp\.linear\.app\) When the user wants/);
    expect(text).toMatch(/- \*\*weather\*\* — When the user asks/);
    expect(text).toContain('`.ax/skills/<name>/SKILL.md`');
  });

  test('renders invalid skills with marker', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [{ name: 'bad', description: 'broken', kind: 'invalid' }] });
    const text = mod.render(ctx).join('\n');
    expect(text).toMatch(/- \*\*bad\*\* — \(invalid\) broken/);
  });

  test('treats legacy SkillSummary (no kind) as enabled', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [{ name: 'legacy', description: 'old skill', path: 'legacy.md' }] });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('- **legacy** — old skill');
    expect(text).not.toContain('pending');
    expect(text).not.toContain('invalid');
  });

  test('falls back to "(setup pending)" when pending has no reasons', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [{ name: 'foo', description: 'foo skill', kind: 'pending' }] });
    const text = mod.render(ctx).join('\n');
    expect(text).toMatch(/- \*\*foo\*\* — \(setup pending\) foo skill/);
  });

  test('omits dash + description cleanly when description is missing', () => {
    const mod = new SkillsModule();
    // description is typed as required on SkillSummary but host-supplied rows
    // can have it absent when the reconciler stores an invalid frontmatter
    // row with no description. Cast through unknown to simulate the wire.
    const ctx = makeContext({
      skills: [
        { name: 'bare-enabled' } as unknown as import('../../../../src/agent/prompt/types.js').SkillSummary,
        { name: 'bare-invalid', kind: 'invalid' } as unknown as import('../../../../src/agent/prompt/types.js').SkillSummary,
      ],
    });
    const text = mod.render(ctx).join('\n');
    expect(text).not.toContain('undefined');
    // Enabled with no description → just the name bullet, no trailing em dash.
    expect(text).toMatch(/^- \*\*bare-enabled\*\*$/m);
    // Invalid with no description → kind prefix but no trailing whitespace.
    expect(text).toMatch(/^- \*\*bare-invalid\*\* — \(invalid\)$/m);
  });

  test('priority is 70', () => {
    const mod = new SkillsModule();
    expect(mod.priority).toBe(70);
  });

  test('includes skill creation instructions pointing to .ax/skills/ when workspace available', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')], hasWorkspace: true });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('.ax/skills/<name>/SKILL.md');
    expect(rendered).toContain('commit and push');
    expect(rendered).not.toContain('/workspace/skills/');
    expect(rendered).not.toContain('type: "create"');
  });

  test('omits skill creation when no workspace', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).not.toContain('Creating Skills');
  });

  test('includes creating skills section when workspace available', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('Test Skill', 'Do stuff')], hasWorkspace: true });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('Creating Skills');
  });

  test('includes skill usage guidance', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: [makeSkill('test', 'Desc')] });
    const rendered = mod.render(ctx).join('\n');
    expect(rendered).toContain('To use a skill');
    expect(rendered).toContain('`.ax/skills/<name>/SKILL.md`');
  });

  test('renderMinimal shows skill count', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [makeSkill('A', 'a'), makeSkill('B', 'b'), makeSkill('C', 'c')],
    });
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('3 skills available');
  });

  test('renderMinimal references the .ax/skills path', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({
      skills: [{ name: 'a', description: 'a desc' }, { name: 'b', description: 'b desc' }],
    });
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('2 skills available');
    expect(text).toContain('.ax/skills/<name>/SKILL.md');
  });

  test('renderMinimal with no skills shows simple message', () => {
    const mod = new SkillsModule();
    const ctx = makeContext();
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('No skills installed.');
  });
});
