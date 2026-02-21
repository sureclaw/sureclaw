// tests/agent/prompt/modules/heartbeat.test.ts
import { describe, test, expect } from 'vitest';
import { HeartbeatModule } from '../../../../src/agent/prompt/modules/heartbeat.js';
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
    identityFiles: { agents: '', soul: 'I am me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '' },

    contextWindow: 200000,
    historyTokens: 0,
    ...overrides,
  };
}

describe('HeartbeatModule', () => {
  const mod = new HeartbeatModule();

  test('has correct name and priority', () => {
    expect(mod.name).toBe('heartbeat');
    expect(mod.priority).toBe(80);
  });

  test('is optional', () => {
    expect(mod.optional).toBe(true);
  });

  test('shouldInclude returns true when heartbeat content exists', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: 'I am me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '# Checks\n- stuff' },
    });
    expect(mod.shouldInclude(ctx)).toBe(true);
  });

  test('shouldInclude returns false when heartbeat is empty', () => {
    expect(mod.shouldInclude(makeContext())).toBe(false);
  });

  test('shouldInclude returns false when heartbeat is whitespace only', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: 'I am me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '   \n  ' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('shouldInclude returns false in bootstrap mode', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: '', identity: '', user: '', bootstrap: 'bootstrap instructions', userBootstrap: '', heartbeat: '# Checks' },
    });
    expect(mod.shouldInclude(ctx)).toBe(false);
  });

  test('render includes heartbeat instructions and HEARTBEAT_OK', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: 'me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '# Checks\n- review emails (every 2h)' },
    });
    const text = mod.render(ctx).join('\n');
    expect(text).toContain('HEARTBEAT_OK');
    expect(text).toContain('scheduler_add_cron');
    expect(text).toContain('scheduler_run_at');
    expect(text).toContain('scheduler_remove_cron');
    expect(text).toContain('scheduler_list_jobs');
    expect(text).toContain('review emails');
  });

  test('renderMinimal includes HEARTBEAT_OK and checklist', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: 'me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '# Checks\n- review' },
    });
    const text = mod.renderMinimal!(ctx).join('\n');
    expect(text).toContain('HEARTBEAT_OK');
    expect(text).toContain('# Checks');
  });

  test('estimateTokens returns a positive number', () => {
    const ctx = makeContext({
      identityFiles: { agents: '', soul: 'me', identity: '', user: '', bootstrap: '', userBootstrap: '', heartbeat: '# Checks\n- stuff' },
    });
    expect(mod.estimateTokens(ctx)).toBeGreaterThan(0);
  });
});
