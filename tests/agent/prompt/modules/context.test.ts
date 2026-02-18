// tests/agent/prompt/modules/context.test.ts
import { describe, test, expect } from 'vitest';
import { ContextModule } from '../../../../src/agent/prompt/modules/context.js';
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
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('ContextModule', () => {
  test('not included when contextContent is empty', () => {
    const mod = new ContextModule();
    expect(mod.shouldInclude(makeContext())).toBe(false);
  });

  test('included when contextContent is present', () => {
    const mod = new ContextModule();
    expect(mod.shouldInclude(makeContext({ contextContent: 'Project info here.' }))).toBe(true);
  });

  test('renders context content', () => {
    const mod = new ContextModule();
    const text = mod.render(makeContext({ contextContent: 'This is a Node.js project.' })).join('\n');
    expect(text).toContain('## Context');
    expect(text).toContain('Node.js project');
  });

  test('is optional (can be dropped for budget)', () => {
    const mod = new ContextModule();
    expect(mod.optional).toBe(true);
  });

  test('priority is 60', () => {
    const mod = new ContextModule();
    expect(mod.priority).toBe(60);
  });
});
