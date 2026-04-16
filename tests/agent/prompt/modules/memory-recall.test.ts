// tests/agent/prompt/modules/memory-recall.test.ts
import { describe, test, expect } from 'vitest';
import { MemoryRecallModule } from '../../../../src/agent/prompt/modules/memory-recall.js';
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
    identityFiles: { agents: '', soul: 'Test soul.', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },

    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('MemoryRecallModule', () => {
  const mod = new MemoryRecallModule();

  test('priority is 60', () => {
    expect(mod.priority).toBe(60);
  });

  test('is optional', () => {
    expect(mod.optional).toBe(true);
  });

  test('included in normal mode', () => {
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('excluded in bootstrap mode', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', bootstrap: 'Boot...', userBootstrap: '', heartbeat: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('render includes memory query instruction', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('memory');
    expect(text).toContain('query');
  });

  test('render includes memory write instruction', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('memory');
    expect(text).toContain('write');
  });

  test('render includes memory read instruction', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('memory');
    expect(text).toContain('read');
  });

  test('render includes proactive search guidance', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('search your memory first');
  });

  test('render includes "mental notes" warning', () => {
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Mental notes');
    expect(text).toContain('don\'t survive session restarts');
  });

  test('renderMinimal is compact', () => {
    const text = mod.renderMinimal!(makeContext()).join('\n');
    expect(text).toContain('memory');
    expect(text).toContain('query');
    expect(text).toContain('write');
    expect(text.length).toBeLessThan(mod.render(makeContext()).join('\n').length);
  });
});
