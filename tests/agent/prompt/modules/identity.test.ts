// tests/agent/prompt/modules/identity.test.ts
import { describe, test, expect } from 'vitest';
import { IdentityModule } from '../../../../src/agent/prompt/modules/identity.js';
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
    identityFiles: { agent: '', soul: '', identity: '', user: '', bootstrap: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('IdentityModule', () => {
  test('always included', () => {
    const mod = new IdentityModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('priority is 0 (first module)', () => {
    const mod = new IdentityModule();
    expect(mod.priority).toBe(0);
  });

  test('bootstrap mode: returns only BOOTSTRAP.md when soul is absent', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agent: '', soul: '', identity: '', user: '',
        bootstrap: 'You are bootstrapping. Discover your identity.',
      },
    });
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('bootstrapping');
    expect(text).not.toContain('## Soul');
  });

  test('normal mode: includes AGENT.md + identity files', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agent: 'You are TestBot.',
        soul: 'I am curious and helpful.',
        identity: 'Name: TestBot',
        user: 'User prefers short answers.',
        bootstrap: '',
      },
    });
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('You are TestBot.');
    expect(text).toContain('## Soul');
    expect(text).toContain('curious and helpful');
    expect(text).toContain('## Identity');
    expect(text).toContain('## User');
  });

  test('default agent instruction when AGENT.md is empty', () => {
    const mod = new IdentityModule();
    const ctx = makeContext();
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('security-first AI agent');
    expect(text).toContain('canary tokens');
  });

  test('skips empty identity sections', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: { agent: 'Custom agent.', soul: '', identity: '', user: '', bootstrap: '' },
    });
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('Custom agent.');
    expect(text).not.toContain('## Soul');
    expect(text).not.toContain('## Identity');
    expect(text).not.toContain('## User');
  });
});
