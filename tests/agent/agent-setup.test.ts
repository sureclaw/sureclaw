import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSystemPrompt } from '../../src/agent/agent-setup.js';
import type { AgentConfig } from '../../src/agent/runner.js';

describe('buildSystemPrompt', () => {
  const agentWs = join(tmpdir(), 'ax-test-agent-setup-agent-' + Date.now());
  const userWs = join(tmpdir(), 'ax-test-agent-setup-user-' + Date.now());

  beforeEach(() => {
    mkdirSync(join(agentWs, 'skills'), { recursive: true });
    mkdirSync(join(userWs, 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(agentWs, { recursive: true, force: true });
    rmSync(userWs, { recursive: true, force: true });
  });

  test('loads skills from agent and user workspace directories', () => {
    writeFileSync(join(agentWs, 'skills', 'deploy.md'), '# Deploy\nDeploy to production');
    writeFileSync(join(userWs, 'skills', 'custom.md'), '# Custom\nUser custom skill');

    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace: '/workspace',
      agentWorkspace: agentWs,
      userWorkspace: userWs,
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toContain('Deploy');
    expect(result.systemPrompt).toContain('Custom');
  });

  test('produces prompt without skills when no workspaces', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace: '/workspace',
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});
