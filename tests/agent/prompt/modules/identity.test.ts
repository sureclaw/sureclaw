// tests/agent/prompt/modules/identity.test.ts
import { describe, test, expect } from 'vitest';
import { IdentityModule } from '../../../../src/agent/prompt/modules/identity.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

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

describe('IdentityModule', () => {
  test('always included', () => {
    const mod = new IdentityModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('priority is 0 (first module)', () => {
    const mod = new IdentityModule();
    expect(mod.priority).toBe(0);
  });

  // ── Bootstrap mode (missing soul or identity) ──

  test('bootstrap mode: returns ONLY BOOTSTRAP.md content (no evolution guidance)', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: '', identity: '',
        bootstrap: 'You are bootstrapping. Discover your identity.', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('bootstrapping');
    expect(text).not.toContain('Identity Evolution');
    expect(text).not.toContain('## Soul');
  });

  test('bootstrap mode activates when soul is missing (even without BOOTSTRAP.md)', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'Custom agent.', soul: '', identity: '',
        bootstrap: '', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    // No soul + no identity = bootstrap mode, even with empty bootstrap content
    expect(text).not.toContain('Custom agent.');
    expect(text).not.toContain('Identity Evolution');
  });

  test('bootstrap mode activates when only identity is missing', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: 'Soul content.', identity: '',
        bootstrap: 'Discover yourself.', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('Discover yourself.');
    expect(text).not.toContain('Soul content.');
    expect(text).not.toContain('Identity Evolution');
  });

  test('bootstrap mode excludes evolution guidance to prevent premature file writes', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: '', identity: '',
        bootstrap: 'Discover your identity.', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('Discover your identity.');
    expect(text).not.toContain('Identity Evolution');
    expect(text).not.toContain('How to Modify Identity');
    expect(text).not.toContain('When to Evolve');
  });

  // ── Normal mode (both soul and identity present) ──

  test('normal mode: includes AGENTS.md + identity files', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'You are TestBot.',
        soul: 'I am curious and helpful.',
        identity: 'Name: TestBot',
        bootstrap: '', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('You are TestBot.');
    expect(text).toContain('## Soul');
    expect(text).toContain('curious and helpful');
    expect(text).toContain('## Identity');
  });

  test('default agent instruction when AGENTS.md is empty', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: 'Soul.', identity: 'Identity.',
        bootstrap: '', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('security-first AI agent');
    expect(text).toContain('canary tokens');
  });

  test('tells agent about write_file-based identity evolution', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: 'You are TestBot.',
        soul: 'I am curious.',
        identity: 'Name: TestBot',
        bootstrap: '', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('Identity Evolution');
    expect(text).toContain('.ax/SOUL.md');
    expect(text).toContain('.ax/IDENTITY.md');
    expect(text).toContain('write_file');
    expect(text).not.toContain('git add');
    expect(text).not.toContain('git commit');
    expect(text).toContain('do not run git commands');
  });

  test('mentions When to Evolve section', () => {
    const mod = new IdentityModule();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: 'Soul.', identity: 'Identity.',
        bootstrap: '', userBootstrap: '', heartbeat: '',
      },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('When to Evolve');
    expect(text).toContain('meaningful interaction');
    expect(text).toContain('git history');
  });
});
