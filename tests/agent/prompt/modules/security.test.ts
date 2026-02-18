// tests/agent/prompt/modules/security.test.ts
import { describe, test, expect } from 'vitest';
import { SecurityModule } from '../../../../src/agent/prompt/modules/security.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-agent-core',
    workspace: '/tmp',
    skills: [],
    profile: 'paranoid',
    sandboxType: 'nsjail',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: '', userBootstrap: '' },
    contextContent: '',
    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('SecurityModule', () => {
  test('always included', () => {
    const mod = new SecurityModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('priority is 10', () => {
    const mod = new SecurityModule();
    expect(mod.priority).toBe(10);
  });

  test('renders sandbox tier', () => {
    const mod = new SecurityModule();
    const text = mod.render(makeContext({ sandboxType: 'docker' })).join('\n');
    expect(text).toContain('docker');
  });

  test('includes core constraints', () => {
    const mod = new SecurityModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Security Boundaries');
    expect(text).toContain('No Independent Goals');
    expect(text).toContain('Credential Protection');
    expect(text).toContain('Audit Trail');
  });

  test('not included in bootstrap mode', () => {
    const mod = new SecurityModule();
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: 'Bootstrap...', userBootstrap: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('does NOT claim identity files are immutable', () => {
    const mod = new SecurityModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).not.toContain('Immutable Files');
    expect(text).not.toContain('cannot modify SOUL.md');
  });

  test('mentions identity is agent-owned', () => {
    const mod = new SecurityModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('Identity Ownership');
    expect(text).toContain('audited');
  });
});
