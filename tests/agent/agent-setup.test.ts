import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSystemPrompt } from '../../src/agent/agent-setup.js';
import type { AgentConfig } from '../../src/agent/runner.js';

describe('buildSystemPrompt', () => {
  const workspace = join(tmpdir(), 'ax-test-agent-setup-ws-' + Date.now());

  beforeEach(() => {
    mkdirSync(join(workspace, '.ax', 'skills'), { recursive: true });
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test('loads skills from workspace/skills/ directory', () => {
    writeFileSync(join(workspace, '.ax', 'skills', 'deploy.md'), '# Deploy\nDeploy to production');
    writeFileSync(join(workspace, '.ax', 'skills', 'custom.md'), '# Custom\nUser custom skill');

    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toContain('Deploy');
    expect(result.systemPrompt).toContain('Custom');
  });

  test('produces prompt without skills when skills dir is empty', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});
