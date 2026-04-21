import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
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

  test('AgentConfig accepts a catalog field (Task 2.3 shipping, not yet rendered)', () => {
    // Task 2.3 ships the catalog to the agent via stdin. Rendering lands in
    // Task 2.4 — this test only locks in that the field is accepted by the
    // config shape without breaking prompt construction.
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace,
      skills: [],
      catalog: [
        {
          name: 'mcp_linear_x',
          skill: 'linear',
          summary: 's',
          schema: { type: 'object' },
          dispatch: { kind: 'mcp', server: 'linear', toolName: 'x' },
        },
      ],
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toBeDefined();
    expect(result.systemPrompt.length).toBeGreaterThan(0);
  });
});
