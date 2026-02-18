// tests/agent/prompt/budget.test.ts
import { describe, test, expect } from 'vitest';
import { allocateModules } from '../../../src/agent/prompt/budget.js';
import type { PromptModule, PromptContext } from '../../../src/agent/prompt/types.js';

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

function fakeMod(name: string, tokens: number, optional: boolean): PromptModule {
  return {
    name,
    priority: 0,
    shouldInclude: () => true,
    render: () => ['x'.repeat(tokens * 4)], // tokens * 4 chars = tokens tokens
    estimateTokens: () => tokens,
    optional,
  };
}

describe('allocateModules', () => {
  test('all modules fit when budget is large', () => {
    const mods = [
      fakeMod('a', 100, false),
      fakeMod('b', 100, true),
    ];
    const result = allocateModules(mods, makeContext({ contextWindow: 200000, historyTokens: 0 }));
    expect(result.map(m => m.module.name)).toEqual(['a', 'b']);
    expect(result.every(m => !m.useMinimal)).toBe(true);
  });

  test('drops optional modules when budget is tight', () => {
    const mods = [
      fakeMod('required', 500, false),
      fakeMod('optional1', 300, true),
      fakeMod('optional2', 300, true),
    ];
    // Budget: 1000 tokens total, history takes 500, leaves 500 for prompt (minus 4096 reserve = negative)
    // Only required modules survive
    const result = allocateModules(mods, makeContext({ contextWindow: 1000, historyTokens: 500 }));
    expect(result.map(m => m.module.name)).toEqual(['required']);
  });

  test('required modules always included even if over budget', () => {
    const mods = [fakeMod('critical', 1000, false)];
    const result = allocateModules(mods, makeContext({ contextWindow: 500, historyTokens: 0 }));
    expect(result.map(m => m.module.name)).toEqual(['critical']);
  });

  test('uses renderMinimal when full version does not fit', () => {
    const mod: PromptModule = {
      name: 'shrinkable',
      priority: 0,
      optional: true,
      shouldInclude: () => true,
      render: () => ['x'.repeat(2000)],  // 500 tokens
      estimateTokens: () => 500,
      renderMinimal: () => ['x'.repeat(400)], // 100 tokens
    };
    // Budget: 400 - 150 - 4096 = negative, but OUTPUT_RESERVE is an internal detail.
    // Use larger values: contextWindow=10000, historyTokens=0, required=50 tokens
    // Budget = 10000 - 0 - 4096 = 5904. Required=50 fits. Full shrinkable=500 fits too.
    // Use tighter budget: contextWindow=4400, historyTokens=0 => budget=304.
    // Required=50 fits (254 remaining). Full shrinkable=500 won't fit, minimal=100 fits.
    const result = allocateModules(
      [fakeMod('req', 50, false), mod],
      makeContext({ contextWindow: 4400, historyTokens: 0 })
    );
    expect(result.map(m => m.module.name)).toContain('shrinkable');
    const shrinkable = result.find(m => m.module.name === 'shrinkable');
    expect(shrinkable?.useMinimal).toBe(true);
  });

  test('drops optional module when neither full nor minimal fits', () => {
    const mod: PromptModule = {
      name: 'too-big',
      priority: 0,
      optional: true,
      shouldInclude: () => true,
      render: () => ['x'.repeat(2000)],  // 500 tokens
      estimateTokens: () => 500,
      renderMinimal: () => ['x'.repeat(1200)], // 300 tokens
    };
    // Budget: 4200 - 0 - 4096 = 104. Required=50 fits (54 remaining). Neither 500 nor 300 fits.
    const result = allocateModules(
      [fakeMod('req', 50, false), mod],
      makeContext({ contextWindow: 4200, historyTokens: 0 })
    );
    expect(result.map(m => m.module.name)).toEqual(['req']);
  });
});
