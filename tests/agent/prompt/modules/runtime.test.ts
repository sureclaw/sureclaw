// tests/agent/prompt/modules/runtime.test.ts
import { describe, test, expect } from 'vitest';
import { RuntimeModule } from '../../../../src/agent/prompt/modules/runtime.js';
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

describe('RuntimeModule', () => {
  test('included in normal mode', () => {
    const mod = new RuntimeModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('not included in bootstrap mode', () => {
    const mod = new RuntimeModule();
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: 'Boot...', userBootstrap: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('renders agent type and sandbox', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      agentType: 'claude-code',
      sandboxType: 'nsjail',
      profile: 'balanced',
    })).join('\n');
    expect(text).toContain('claude-code');
    expect(text).toContain('nsjail');
    expect(text).toContain('balanced');
  });

  test('priority is 90 (last)', () => {
    const mod = new RuntimeModule();
    expect(mod.priority).toBe(90);
  });

  test('is optional', () => {
    const mod = new RuntimeModule();
    expect(mod.optional).toBe(true);
  });
});
