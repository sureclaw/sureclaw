// tests/agent/prompt/modules/security.test.ts
import { describe, test, expect } from 'vitest';
import { SecurityModule } from '../../../../src/agent/prompt/modules/security.js';
import type { PromptContext } from '../../../../src/agent/prompt/types.js';

function makeContext(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    agentType: 'pi-coding-agent',
    workspace: '/tmp',
    skills: [],
    profile: 'paranoid',
    sandboxType: 'docker',
    taintRatio: 0,
    taintThreshold: 0.10,
    identityFiles: { agents: '', soul: 'Test soul.', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },

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
      identityFiles: { agents: '', soul: '', identity: '', bootstrap: 'Bootstrap...', userBootstrap: '', heartbeat: '' },
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
    expect(text).toContain('git history');
  });

  test('renderMinimal produces compact output with sandbox type', () => {
    const mod = new SecurityModule();
    const text = mod.renderMinimal!(makeContext({ sandboxType: 'docker' })).join('\n');
    expect(text).toContain('## Security');
    expect(text).toContain('No independent goals');
    expect(text).toContain('docker');
    expect(text).toContain('host-injected');
    expect(text).toContain('tamper-evident');
    expect(text.length).toBeLessThan(mod.render(makeContext()).join('\n').length);
  });
});
