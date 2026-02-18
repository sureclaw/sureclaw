// tests/agent/prompt/modules/injection-defense.test.ts
import { describe, test, expect } from 'vitest';
import { InjectionDefenseModule } from '../../../../src/agent/prompt/modules/injection-defense.js';
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

describe('InjectionDefenseModule', () => {
  test('always included (except bootstrap)', () => {
    const mod = new InjectionDefenseModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('not included in bootstrap mode', () => {
    const mod = new InjectionDefenseModule();
    const ctx = makeContext({
      identityFiles: { agent: '', soul: '', identity: '', user: '', bootstrap: 'Bootstrap...' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('priority is 5 (before security)', () => {
    const mod = new InjectionDefenseModule();
    expect(mod.priority).toBe(5);
  });

  test('includes attack recognition patterns', () => {
    const mod = new InjectionDefenseModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Prompt Injection Defense');
    expect(text).toContain('Ignore all previous instructions');
    expect(text).toContain('Direct Injection');
    expect(text).toContain('Indirect Injection');
    expect(text).toContain('Exfiltration');
  });

  test('includes taint ratio and threshold', () => {
    const mod = new InjectionDefenseModule();
    const text = mod.render(makeContext({ taintRatio: 0.25, taintThreshold: 0.30 })).join('\n');
    expect(text).toContain('25.0%');
    expect(text).toContain('30%');
  });

  test('renders elevated warning when taint is high', () => {
    const mod = new InjectionDefenseModule();
    const text = mod.render(makeContext({ taintRatio: 0.45, taintThreshold: 0.30 })).join('\n');
    expect(text).toContain('ELEVATED');
  });

  test('has renderMinimal for tight budgets', () => {
    const mod = new InjectionDefenseModule();
    expect(mod.renderMinimal).toBeDefined();
    const text = mod.renderMinimal!(makeContext()).join('\n');
    expect(text).toContain('Injection Defense');
    // Minimal version should be shorter
    const fullText = mod.render(makeContext()).join('\n');
    expect(text.length).toBeLessThan(fullText.length);
  });
});
