// tests/agent/prompt/types.test.ts
import { describe, test, expect } from 'vitest';
import { isBootstrapMode } from '../../../src/agent/prompt/types.js';
import type { PromptContext, PromptModule } from '../../../src/agent/prompt/types.js';

describe('PromptContext', () => {
  test('can construct a valid PromptContext', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/tmp/test',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: '', soul: '', identity: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(ctx.profile).toBe('paranoid');
    expect(ctx.taintRatio).toBe(0);
  });
});

describe('isBootstrapMode', () => {
  test('returns true when soul is empty (regardless of bootstrap)', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/tmp',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: '', soul: '', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },

      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(isBootstrapMode(ctx)).toBe(true);
  });

  test('returns true when identity is empty', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/tmp',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: '', soul: 'I have a soul', identity: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

      contextWindow: 200000,
      historyTokens: 0,
    };
    expect(isBootstrapMode(ctx)).toBe(true);
  });

  test('returns false when BOTH soul AND identity are present', () => {
    const ctx: PromptContext = {
      agentType: 'pi-coding-agent',
      workspace: '/tmp',
      skills: [],
      profile: 'paranoid',
      sandboxType: 'docker',
      taintRatio: 0,
      taintThreshold: 0.10,
      identityFiles: { agents: '', soul: 'I have a soul', identity: 'I have identity', bootstrap: '', userBootstrap: '', heartbeat: '' },

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
