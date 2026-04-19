/**
 * Tests `resolveMcpAuthHeaders` — the callback that `server-completions.ts`
 * feeds into `mcpManager.discoverAllTools` so MCP servers declared by skills
 * can be authenticated at tool-discovery time using skill-scoped credentials.
 */
import { describe, test, expect, afterEach } from 'vitest';
import { resolveMcpAuthHeaders } from '../../src/host/server-completions.js';
import type {
  SkillCredStore,
  SkillCredRow,
} from '../../src/host/skills/skill-cred-store.js';

function storeWith(rows: SkillCredRow[]): SkillCredStore {
  return {
    async put() {},
    async get() { return null; },
    async listForAgent() { return rows; },
    async listEnvNames() { return new Set(rows.map(r => r.envName)); },
  };
}

const savedEnv = { ...process.env };
afterEach(() => {
  // Restore any env keys we mutated during a test so state doesn't leak.
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k];
  }
  for (const k of Object.keys(savedEnv)) {
    process.env[k] = savedEnv[k];
  }
});

describe('resolveMcpAuthHeaders', () => {
  test('returns Bearer header from a matching skill-scoped credential', async () => {
    const store = storeWith([
      {
        skillName: 'linear',
        envName: 'LINEAR_API_KEY',
        userId: 'u1',
        value: 'sk-linear-user',
      },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer sk-linear-user' });
  });

  test('prefers the user-scoped row over the agent-scope sentinel', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '',   value: 'shared' },
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: 'u1', value: 'user-only' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer user-only' });
  });

  test('falls back to agent-scope sentinel when no user-scoped row matches', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '', value: 'shared' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer shared' });
  });

  test('normalises server name hyphens to underscores for env lookup', async () => {
    const store = storeWith([
      { skillName: 'gh', envName: 'GITHUB_MCP_API_KEY', userId: '', value: 'gh-key' },
    ]);
    const headers = await resolveMcpAuthHeaders({
      serverName: 'github-mcp',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer gh-key' });
  });

  test('tries _ACCESS_TOKEN / _OAUTH_TOKEN / _TOKEN when _API_KEY is absent', async () => {
    const store = storeWith([
      { skillName: 'slack', envName: 'SLACK_OAUTH_TOKEN', userId: '', value: 'xoxb-123' },
    ]);
    delete process.env['SLACK_API_KEY'];
    delete process.env['SLACK_ACCESS_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'slack',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer xoxb-123' });
  });

  test('returns undefined when no rows match and process.env is empty', async () => {
    const store = storeWith([]);
    delete process.env['LINEAR_API_KEY'];
    delete process.env['LINEAR_ACCESS_TOKEN'];
    delete process.env['LINEAR_OAUTH_TOKEN'];
    delete process.env['LINEAR_TOKEN'];
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toBeUndefined();
  });

  test('uses process.env as last-resort fallback when no skill_credentials row exists', async () => {
    const store = storeWith([]);
    delete process.env['LINEAR_API_KEY'];
    process.env['LINEAR_ACCESS_TOKEN'] = 'from-env';
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer from-env' });
  });

  test('skill_credentials row wins over process.env when both are present', async () => {
    const store = storeWith([
      { skillName: 'linear', envName: 'LINEAR_API_KEY', userId: '', value: 'from-store' },
    ]);
    process.env['LINEAR_API_KEY'] = 'from-env';
    const headers = await resolveMcpAuthHeaders({
      serverName: 'linear',
      agentId: 'pi',
      userId: 'u1',
      skillCredStore: store,
    });
    expect(headers).toEqual({ Authorization: 'Bearer from-store' });
  });
});
