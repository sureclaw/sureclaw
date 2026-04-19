import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

  test('produces prompt when config.skills is empty and host sends no skills', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
      skills: [],
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });

  test('uses config.skills verbatim in the system prompt', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
      skills: [
        { name: 'linear', description: 'Linear issues', kind: 'pending', pendingReasons: ['needs LINEAR_TOKEN'] },
        { name: 'weather', description: 'Weather forecasts', kind: 'enabled' },
      ],
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toContain('## Available skills');
    expect(result.systemPrompt).toMatch(/- \[PENDING\] \*\*linear\*\* — Linear issues \(waiting on: needs LINEAR_TOKEN\)/);
    expect(result.systemPrompt).toMatch(/- \[ENABLED\] \*\*weather\*\* — Weather forecasts/);
  });

  test('treats missing config.skills the same as an empty array (no filesystem scan)', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace: '/nonexistent-dir-no-filesystem-scan',
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });

  test('surfaces committed tool-module index from .ax/tools/<skill>/_index.json', () => {
    const toolsDir = join(workspace, '.ax', 'tools', 'linear');
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(
      join(toolsDir, '_index.json'),
      JSON.stringify({
        skill: 'linear',
        tools: [
          {
            name: 'list_issues',
            parameters: { type: 'object', properties: { limit: {} }, required: [] },
          },
        ],
        generated_at: '2026-04-18T20:00:00Z',
      }),
    );

    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
      skills: [],
      identity: { agents: '', soul: 'Test soul.', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toContain('/workspace/.ax/tools/');
    expect(result.systemPrompt).toContain('linear: listIssues({ limit? })');
  });

  test('omits tool-module block when no .ax/tools/ index is present', () => {
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
      skills: [],
      identity: { agents: '', soul: 'Test soul.', identity: 'Test identity.', bootstrap: '', userBootstrap: '', heartbeat: '' },
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).not.toContain('/workspace/.ax/tools/');
  });
});
