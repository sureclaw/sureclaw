// tests/agent/prompt/modules/tool-style.test.ts
import { describe, test, expect } from 'vitest';
import { ToolStyleModule } from '../../../../src/agent/prompt/modules/tool-style.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp',
    skills: [],
    profile: 'balanced',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.30,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('ToolStyleModule', () => {
  const mod = new ToolStyleModule();

  test('priority is 12', () => {
    expect(mod.priority).toBe(12);
  });

  test('is optional', () => {
    expect(mod.optional).toBe(true);
  });

  test('included in normal mode', () => {
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('excluded in bootstrap mode', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: 'Boot...', userBootstrap: '', heartbeat: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('render includes narration guidance', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Narration');
    expect(text).toContain('Do not narrate routine');
  });

  test('render includes batching guidance', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Batching');
    expect(text).toContain('parallel');
  });

  test('render includes error guidance', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Errors');
    expect(text).toContain('alternative');
  });

  test('renderMinimal is compact', () => {
    const text = mod.renderMinimal!(makeContext()).join('\n');
    expect(text).toContain('routine tool calls');
    expect(text.length).toBeLessThan(mod.render(makeContext()).join('\n').length);
  });
});
