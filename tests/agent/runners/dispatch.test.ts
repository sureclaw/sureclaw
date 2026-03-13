import { describe, test, expect } from 'vitest';
import type { AgentConfig, AgentType } from '../../../src/agent/runner.js';

describe('agent-runner dispatch', () => {
  test('AgentConfig interface accepts all agent types', () => {
    const types: AgentType[] = ['pi-coding-agent', 'claude-code'];
    for (const agent of types) {
      const config: AgentConfig = {
        agent,
        ipcSocket: '/tmp/test.sock',
        workspace: '/tmp/workspace',
      };
      expect(config.agent).toBe(agent);
    }
  });

  test('AgentConfig agent field is optional (defaults to pi-coding-agent)', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace: '/tmp/workspace',
    };
    expect(config.agent).toBeUndefined();
  });

  test('run() with empty message returns without connecting', async () => {
    const { run } = await import('../../../src/agent/runner.js');
    // Should not throw — early return for empty messages
    await run({
      ipcSocket: '/tmp/nonexistent.sock',
      workspace: '/tmp/nonexistent',
      userMessage: '   ',
    });
  });

  test('run() with empty message works for all agent types', async () => {
    const { run } = await import('../../../src/agent/runner.js');
    const types: AgentType[] = ['pi-coding-agent', 'claude-code'];
    for (const agent of types) {
      // Should not throw — each agent type early-returns for empty messages
      await run({
        agent,
        ipcSocket: '/tmp/nonexistent.sock',
        workspace: '/tmp/nonexistent',
        userMessage: '',
      });
    }
  });
});
