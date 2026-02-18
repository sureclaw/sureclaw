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
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '' },
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
        agents: '', soul: '', identity: '', user: '',
        bootstrap: 'You are bootstrapping. Discover your identity.', userBootstrap: '',
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
        agents: 'You are TestBot.',
        soul: 'I am curious and helpful.',
        identity: 'Name: TestBot',
        user: 'User prefers short answers.',
        bootstrap: '', userBootstrap: '',
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
      identityFiles: { agents: 'Custom agent.', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    });
    const lines = mod.render(ctx);
    const text = lines.join('\n');
    expect(text).toContain('Custom agent.');
    // Identity file h2 headers should not appear when files are empty
    // (## Identity Evolution is fine — it's the evolution guidance, not a file section)
    expect(text).not.toContain('## Soul\n');
    expect(text).not.toContain('## Identity\n');
    expect(text).not.toContain('## User\n');
  });

  test('tells agent about identity_write and user_write tools', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'You are TestBot.',
        soul: 'I am curious.',
        identity: 'Name: TestBot',
        user: '',
        bootstrap: '', userBootstrap: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('identity_write');
    expect(text).toContain('user_write');
    expect(text).toContain('per-user');
    expect(text).toContain('Identity Evolution');
    // Should NOT reference the removed identity_propose
    expect(text).not.toContain('identity_propose');
  });

  test('explains paranoid profile: always queued', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      profile: 'paranoid',
      identityFiles: { agents: '', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('paranoid');
    expect(text).toContain('queued');
    expect(text).toContain('user');
  });

  test('explains balanced profile: taint-aware auto-apply', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      profile: 'balanced',
      identityFiles: { agents: '', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('auto-applied');
    expect(text).toContain('taint');
    expect(text).toContain('queued');
  });

  test('explains yolo profile: full autonomy', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      profile: 'yolo',
      identityFiles: { agents: '', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('auto-applied');
    expect(text).toContain('full autonomy');
  });

  test('shows user bootstrap when USER.md is absent but USER_BOOTSTRAP.md exists', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'You are TestBot.',
        soul: 'Curious.',
        identity: '',
        user: '',
        bootstrap: '',
        userBootstrap: 'You are meeting a new user. Learn their preferences.',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('## User Discovery');
    expect(text).toContain('Learn their preferences');
    expect(text).not.toContain('## User\n');
  });

  test('skips user bootstrap when USER.md exists', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'Bot.',
        soul: 'Soul.',
        identity: '',
        user: 'Prefers concise answers.',
        bootstrap: '',
        userBootstrap: 'You are meeting a new user.',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('## User');
    expect(text).toContain('Prefers concise answers');
    expect(text).not.toContain('User Discovery');
    expect(text).not.toContain('meeting a new user');
  });

  test('does not include evolution guidance in bootstrap mode', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: '', identity: '', user: '',
        bootstrap: 'Discover your identity.', userBootstrap: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).not.toContain('Identity Evolution');
    expect(text).not.toContain('identity_write');
  });
});
