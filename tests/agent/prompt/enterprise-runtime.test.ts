import { describe, test, expect } from 'vitest';
import { RuntimeModule } from '../../../src/agent/prompt/modules/runtime.js';
import type { PromptContext } from '../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp/test',
    skills: [],
    profile: 'balanced',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: {
      agents: '', soul: 'I am an agent', identity: '', user: '',
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
    expect(content).not.toContain('Workspace Tiers');
    expect(content).not.toContain('Governance');
  });

  test('includes Agent ID when agentId is set', () => {
    const ctx = makeContext({ agentId: 'research-bot' });
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('**Agent ID**: research-bot');
  });

  test('includes workspace tier docs when hasWorkspaceTiers is true', () => {
    const ctx = makeContext({ hasWorkspaceTiers: true });
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('### Workspace Tiers');
    expect(content).toContain('agent');
    expect(content).toContain('user');
    expect(content).toContain('scratch');
  });

  test('includes governance docs when hasGovernance is true', () => {
    const ctx = makeContext({ hasGovernance: true });
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('### Governance');
    expect(content).toContain('identity_propose');
    expect(content).toContain('proposal_list');
  });

  test('includes all enterprise sections when all fields set', () => {
    const ctx = makeContext({
      agentId: 'main',
      hasWorkspaceTiers: true,
      hasGovernance: true,
    });
    const lines = mod.render(ctx);
    const content = lines.join('\n');

    expect(content).toContain('**Agent ID**: main');
    expect(content).toContain('### Workspace Tiers');
    expect(content).toContain('### Governance');
  });
});
