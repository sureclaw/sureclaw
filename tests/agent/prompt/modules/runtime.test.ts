// tests/agent/prompt/modules/runtime.test.ts
import { describe, test, expect } from 'vitest';
import { RuntimeModule } from '../../../../src/agent/prompt/modules/runtime.js';
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

describe('RuntimeModule', () => {
  test('included in normal mode', () => {
    const mod = new RuntimeModule();
    expect(mod.shouldInclude(makeContext())).toBe(true);
  });

  test('not included in bootstrap mode', () => {
    const mod = new RuntimeModule();
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', bootstrap: 'Boot...', userBootstrap: '', heartbeat: '' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('renders agent type and sandbox', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      agentType: 'claude-code',
      sandboxType: 'docker',
      profile: 'balanced',
    })).join('\n');
    expect(text).toContain('claude-code');
    expect(text).toContain('docker');
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

  test('never leaks host workspace path', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      workspace: '/Users/vpulim/.ax/data/workspaces/main/cli/default',
    })).join('\n');
    expect(text).not.toContain('vpulim');
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('.ax/data');
    expect(text).toContain('Working Directory');
    expect(text).toContain('/workspace');
  });

  test('uses static working directory label regardless of workspace path', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext({
      workspace: '/tmp/ax-ws-abc123',
    })).join('\n');
    expect(text).not.toContain('/tmp/');
    expect(text).not.toContain('ax-ws-');
    expect(text).toContain('Working Directory');
  });

  test('renders cache-stable time as ISO 8601 with timezone offset', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext()).join('\n');
    expect(text).toContain('**Current Time**:');
    // Should match ISO 8601 with offset: YYYY-MM-DDTHH:mm:ss±HH:MM
    const match = text.match(/\*\*Current Time\*\*: (\S+)/);
    expect(match).not.toBeNull();
    expect(match![1]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  });

  test('cache-stable time has seconds set to 00 and minutes rounded to 5', () => {
    const mod = new RuntimeModule();
    const text = mod.render(makeContext()).join('\n');
    const match = text.match(/\*\*Current Time\*\*: \d{4}-\d{2}-\d{2}T\d{2}:(\d{2}):(\d{2})/);
    expect(match).not.toBeNull();
    const minutes = parseInt(match![1], 10);
    const seconds = match![2];
    // Minutes should be a multiple of 5
    expect(minutes % 5).toBe(0);
    // Seconds should always be 00
    expect(seconds).toBe('00');
  });
});
