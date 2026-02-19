// tests/agent/prompt/modules/runtime.test.ts
import { describe, test, expect } from 'vitest';
import { RuntimeModule } from '../../../../src/agent/prompt/modules/runtime.js';
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
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('RuntimeModule', () => {
  test('included in normal mode', () => {
    const mod = new RuntimeModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('not included in bootstrap mode', () => {
    const mod = new RuntimeModule();
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: 'Boot...', userBootstrap: '', heartbeat: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('renders agent type and sandbox', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      agentType: 'claude-code',
      sandboxType: 'nsjail',
      profile: 'balanced',
    })).join('\n');
    expect(text).toContain('claude-code');
    expect(text).toContain('nsjail');
    expect(text).toContain('balanced');
  });

  test('priority is 90 (last)', () => {
    const mod = new RuntimeModule();
    expect(mod.priority).toBe(90);
  });

  test('is optional', () => {
    const mod = new RuntimeModule();
    expect(mod.optional).toBe(true);
  });

  test('sanitizes absolute workspace path — never leaks host username', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      workspace: '/Users/vpulim/.ax/data/workspaces/main/cli/default',
    })).join('\n');
    expect(text).not.toContain('vpulim');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('.ax/data');
    expect(text).toContain('./workspace');
  });

  test('sanitizes temp workspace path', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      workspace: '/tmp/ax-ws-abc123',
    })).join('\n');
    expect(text).not.toContain('/tmp/');
    expect(text).not.toContain('ax-ws-');
    expect(text).toContain('./workspace');
  });

  test('sanitizes any unknown workspace path', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      workspace: '/home/someuser/random/path',
    })).join('\n');
    expect(text).not.toContain('someuser');
    expect(text).not.toContain('/home/');
    expect(text).toContain('./workspace');
  });
});
