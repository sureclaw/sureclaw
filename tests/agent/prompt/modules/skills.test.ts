// tests/agent/prompt/modules/skills.test.ts
import { describe, test, expect } from 'vitest';
import { SkillsModule } from '../../../../src/agent/prompt/modules/skills.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp',
    skills: [],
    profile: 'paranoid',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '' },
    contextContent: '',
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
    expect(mod.shouldInclude(makeContext({ skills: ['# Skill 1\nDo things'] }))).toBe(true);
  });

  test('renders skills with separators', () => {
    const mod = new SkillsModule();
    const ctx = makeContext({ skills: ['# Safety\nBe safe.', '# Memory\nRemember things.'] });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('## Skills');
    expect(text).toContain('Be safe.');
    expect(text).toContain('Remember things.');
    expect(text).toContain('---');
  });

  test('priority is 70', () => {
    const mod = new SkillsModule();
    expect(mod.priority).toBe(70);
  });
});
