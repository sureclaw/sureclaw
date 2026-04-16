import { describe, test, expect } from 'vitest';
import { RuntimeModule } from '../../../src/agent/prompt/modules/runtime.js';
import type { PromptContext } from '../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp/test',
    skills: [],
    profile: 'balanced',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: {
      agents: '', soul: 'I am an agent', identity: '',
      bootstrap: '', userBootstrap: '', heartbeat: '',
    },
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('RuntimeModule enterprise features', () => {
  const mod = new RuntimeModule();

  test('renders basic runtime info without enterprise fields', () => {
    const ctx = makeContext();
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('Agent Type');
    expect(content).toContain('Sandbox');
    expect(content).not.toContain('Agent ID');
  });

  test('includes Agent ID when agentId is set', () => {
    const ctx = makeContext({ agentId: 'research-bot' });
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('**Agent ID**: research-bot');
  });
});
