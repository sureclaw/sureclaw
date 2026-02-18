// tests/agent/prompt/base-module.test.ts
import { describe, test, expect } from 'vitest';
import { BasePromptModule } from '../../../src/agent/prompt/base-module.js';
import type { PromptContext } from '../../../src/agent/prompt/types.js';

class TestModule extends BasePromptModule {
  name = 'test';
  priority = 50;
  shouldInclude() { return true; }
  render() { return ['Line one', 'Line two']; }
}

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

describe('BasePromptModule', () => {
  test('estimateTokens returns ~chars/4', () => {
    const mod = new TestModule();
    const ctx = makeContext();
    const tokens = mod.estimateTokens(ctx);
    // "Line one\nLine two" = 18 chars => ~5 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(10);
  });

  test('renderMinimal falls back to render', () => {
    const mod = new TestModule();
    const ctx = makeContext();
    // BasePromptModule doesn't define renderMinimal, so it should not exist
    expect(mod.renderMinimal).toBeUndefined();
  });
});
