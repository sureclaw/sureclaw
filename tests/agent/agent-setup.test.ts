import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildSystemPrompt, fetchSkillsIndex } from '../../src/agent/agent-setup.js';
import type { AgentConfig, IIPCClient } from '../../src/agent/runner.js';

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

  test('buildSystemPrompt uses config.skills when provided (no filesystem scan)', () => {
    // Use a workspace path that does NOT exist to prove no filesystem scan happens.
    const config: AgentConfig = {
      ipcSocket: '/tmp/test.sock',
      workspace: '/nonexistent-dir-no-filesystem-scan',
      skills: [
        { name: 'linear', description: 'Linear issues', kind: 'pending', pendingReasons: ['needs LINEAR_TOKEN'] },
        { name: 'weather', description: 'Weather forecasts', kind: 'enabled' },
      ],
    };
    const result = buildSystemPrompt(config);
    expect(result.systemPrompt).toContain('## Available skills');
    expect(result.systemPrompt).toMatch(/- \*\*linear\*\* — \(setup pending: needs LINEAR_TOKEN\) Linear issues/);
    expect(result.systemPrompt).toMatch(/- \*\*weather\*\* — Weather forecasts/);
  });

  test('buildSystemPrompt falls back to filesystem scan when config.skills is undefined', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'ax-agent-setup-fallback-'));
    try {
      const skillsDir = join(tmp, '.ax', 'skills', 'legacy-skill');
      mkdirSync(skillsDir, { recursive: true });
      // extractSkillMeta (src/agent/stream-utils.ts) parses H1 as the name and
      // the first non-empty non-heading line as the description.
      writeFileSync(
        join(skillsDir, 'SKILL.md'),
        '# legacy-skill\n\nLegacy filesystem skill description\n',
      );

      const config: AgentConfig = {
        ipcSocket: '/tmp/test.sock',
        workspace: tmp,
      };
      const result = buildSystemPrompt(config);
      expect(result.systemPrompt).toContain('legacy-skill');
      expect(result.systemPrompt).toContain('Legacy filesystem skill description');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('buildSystemPrompt treats empty config.skills array as "no skills" (short-circuits scan)', () => {
    // Even when the workspace exists with SKILL.md files, passing skills:[] should win.
    const tmp = mkdtempSync(join(tmpdir(), 'ax-agent-setup-empty-'));
    try {
      const skillsDir = join(tmp, '.ax', 'skills', 'would-be-scanned');
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, 'SKILL.md'),
        '# would-be-scanned\n\nShould NOT appear in prompt\n',
      );

      const config: AgentConfig = {
        ipcSocket: '/tmp/test.sock',
        workspace: tmp,
        skills: [],
      };
      const result = buildSystemPrompt(config);
      expect(result.systemPrompt).not.toContain('would-be-scanned');
      // With zero skills, SkillsModule emits a "No skills" message.
      expect(result.systemPrompt).toContain('No skills are currently installed');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('fetchSkillsIndex', () => {
  function makeFakeClient(
    impl: (request: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ): IIPCClient {
    return {
      call: impl,
      connect: async () => {},
      disconnect: () => {},
      setContext: () => {},
    };
  }

  test('returns skills array when IPC call succeeds', async () => {
    const fakeClient = makeFakeClient(async (req) => {
      expect(req.action).toBe('skills_index');
      return {
        ok: true,
        skills: [
          { name: 'alpha', description: 'A', kind: 'enabled' as const },
          { name: 'beta', description: 'B', kind: 'pending' as const, pendingReasons: ['x'] },
        ],
      };
    });

    const result = await fetchSkillsIndex(fakeClient);
    expect(result).toHaveLength(2);
    expect(result?.[0]?.name).toBe('alpha');
    expect(result?.[1]?.kind).toBe('pending');
  });

  test('returns undefined when client throws (no propagation)', async () => {
    const fakeClient = makeFakeClient(async () => {
      throw new Error('transport boom');
    });
    const result = await fetchSkillsIndex(fakeClient);
    expect(result).toBeUndefined();
  });

  test('returns undefined when response shape is malformed', async () => {
    const fakeClient = makeFakeClient(async () => ({ ok: true }));  // no skills key
    const result = await fetchSkillsIndex(fakeClient);
    expect(result).toBeUndefined();
  });

  test('returns undefined when skills is not an array', async () => {
    const fakeClient = makeFakeClient(async () => ({ ok: true, skills: 'not-an-array' }));
    const result = await fetchSkillsIndex(fakeClient);
    expect(result).toBeUndefined();
  });
});
