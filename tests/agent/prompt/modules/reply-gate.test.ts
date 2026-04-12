import { describe, test, expect } from 'vitest';
import { ReplyGateModule } from '../../../../src/agent/prompt/modules/reply-gate.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp/test',
    skills: [],
    profile: 'balanced',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.3,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

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

  test('not included during bootstrap mode even when replyOptional is true', () => {
    const ctx = makeCtx({
      replyOptional: true,
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '# Bootstrap', userBootstrap: '', heartbeat: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('render produces guidance text', () => {
    const lines = mod.render(makeCtx({ replyOptional: true }));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('may choose not to reply');
  });

  test('render includes SILENT_REPLY instruction', () => {
    const text = mod.render(makeCtx({ replyOptional: true })).join('\n');
    expect(text).toContain('SILENT_REPLY');
    expect(text).toContain('channel tool');
  });
});
