// tests/agent/prompt/types.test.ts
import { describe, test, expect } from 'vitest';
import { isBootstrapMode } from '../../../src/agent/prompt/types.js';
import type { PromptContext, PromptModule } from '../../../src/agent/prompt/types.js';

describe('PromptContext', () => {
  test('can construct a valid PromptContext', () => {
    const ctx: PromptContext = {
      agentType: 'pi-agent-core',
      workspace: '/tmp/test',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agent: '', soul: '', identity: '', user: '', bootstrap: '' },
      contextContent: '',
      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(ctx.profile).toBe('paranoid');
    expect(ctx.taintRatio).toBe(0);
  });
});

describe('isBootstrapMode', () => {
  test('returns true when soul is empty and bootstrap is present', () => {
    const ctx: PromptContext = {
      agentType: 'pi-agent-core',
      workspace: '/tmp',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agent: '', soul: '', identity: '', user: '', bootstrap: 'Bootstrap...' },
      contextContent: '',
      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(isBootstrapMode(ctx)).toBe(true);
  });

  test('returns false when soul is present', () => {
    const ctx: PromptContext = {
      agentType: 'pi-agent-core',
      workspace: '/tmp',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'subprocess',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agent: '', soul: 'I have a soul', identity: '', user: '', bootstrap: '' },
      contextContent: '',
      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(isBootstrapMode(ctx)).toBe(false);
  });

  test('returns false when both soul and bootstrap are empty', () => {
    const ctx: PromptContext = {
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
    };
    expect(isBootstrapMode(ctx)).toBe(false);
  });
});

describe('PromptModule interface', () => {
  test('can implement PromptModule', () => {
    const mod: PromptModule = {
      name: 'test',
      priority: 50,
      shouldInclude: () => true,
      render: () => ['Hello'],
      estimateTokens: () => 2,
    };
    expect(mod.shouldInclude({} as PromptContext)).toBe(true);
    expect(mod.render({} as PromptContext)).toEqual(['Hello']);
  });
});
