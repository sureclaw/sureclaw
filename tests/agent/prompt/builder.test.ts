// tests/agent/prompt/builder.test.ts
import { describe, test, expect } from 'vitest';
import { PromptBuilder } from '../../../src/agent/prompt/builder.js';
import type { PromptContext } from '../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp/test',
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

describe('PromptBuilder', () => {
  test('builds prompt with all modules', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext({
      identityFiles: {
        agents: 'You are TestBot.',
        soul: 'Curious helper.',
        identity: '', user: '', bootstrap: '', userBootstrap: '',
      },
      contextContent: 'Node.js project.',
      skills: ['# Skill\nDo stuff.'],
    });
    const result = builder.build(ctx);

    expect(result.content).toContain('TestBot');
    expect(result.content).toContain('Injection Defense');
    expect(result.content).toContain('Security Boundaries');
    expect(result.content).toContain('Node.js project');
    expect(result.content).toContain('Skill');
    expect(result.metadata.moduleCount).toBeGreaterThan(0);
    expect(result.metadata.estimatedTokens).toBeGreaterThan(0);
  });

  test('modules are ordered by priority', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext({
      identityFiles: { agents: 'Agent.', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
      skills: ['# Skill\nContent.'],
    });
    const result = builder.build(ctx);

    // Identity (0) should come before injection defense (5) before security (10)
    const identityPos = result.content.indexOf('Agent.');
    const injectionPos = result.content.indexOf('Injection Defense');
    const securityPos = result.content.indexOf('Security Boundaries');

    expect(identityPos).toBeLessThan(injectionPos);
    expect(injectionPos).toBeLessThan(securityPos);
  });

  test('bootstrap mode returns only bootstrap content', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext({
      identityFiles: {
        agents: '', soul: '', identity: '', user: '',
        bootstrap: 'Discover your identity.', userBootstrap: '',
      },
    });
    const result = builder.build(ctx);

    expect(result.content).toContain('Discover your identity');
    // In bootstrap mode, security/injection/runtime modules are excluded
    expect(result.content).not.toContain('Security Boundaries');
    expect(result.content).not.toContain('Injection Defense');
  });

  test('metadata includes module names', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext({
      identityFiles: { agents: 'Bot.', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    });
    const result = builder.build(ctx);

    expect(result.metadata.modules).toContain('identity');
    expect(result.metadata.modules).toContain('security');
    expect(result.metadata.modules).toContain('injection-defense');
  });

  test('empty context and skills are excluded', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext();
    const result = builder.build(ctx);

    expect(result.metadata.modules).not.toContain('context');
    expect(result.metadata.modules).not.toContain('skills');
  });

  test('metadata includes per-module token breakdown', () => {
    const builder = new PromptBuilder();
    const ctx = makeContext({
      identityFiles: { agents: 'Bot.', soul: 'Soul.', identity: '', user: '', bootstrap: '', userBootstrap: '' },
      contextContent: 'Context.',
      skills: ['# Skill\nContent.'],
    });
    const result = builder.build(ctx);
    expect(result.metadata.tokensByModule).toBeDefined();
    expect(Object.keys(result.metadata.tokensByModule).length).toBeGreaterThan(0);
    // Each entry should be a positive number
    for (const [_name, tokens] of Object.entries(result.metadata.tokensByModule)) {
      expect(typeof tokens).toBe('number');
      expect(tokens).toBeGreaterThan(0);
    }
  });
});
