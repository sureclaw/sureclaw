import { describe, test, expect } from 'vitest';
import { ReplyGateModule } from '../../../../src/agent/prompt/modules/reply-gate.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp/test',
    skills: [],
    profile: 'balanced',
    sandboxType: 'subprocess',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    replyOptional: false,
    ...overrides,
  };
}

describe('ReplyGateModule', () => {
  const mod = new ReplyGateModule();

  test('not included when replyOptional is false', () => {
    expect(mod.shouldInclude(makeCtx({ replyOptional: false }))).toBe(false);
  });

  test('included when replyOptional is true', () => {
    expect(mod.shouldInclude(makeCtx({ replyOptional: true }))).toBe(true);
  });

  test('render produces guidance text', () => {
    const lines = mod.render(makeCtx({ replyOptional: true }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('may choose not to reply');
  });
});
