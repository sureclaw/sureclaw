import { describe, test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolve } from 'node:path';

/** Minimal valid config — providers/sandbox/scheduler all use code defaults. */
const MINIMAL_CONFIG = `profile: balanced\n`;

/** Helper to write a temp config, run a test, and clean up. */
async function withTempConfig(yaml: string, fn: (path: string) => void): Promise<void> {
  const { writeFileSync, rmSync } = await import('node:fs');
  const tmpPath = resolve(import.meta.dirname, `../ax-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  writeFileSync(tmpPath, yaml);
  try {
    fn(tmpPath);
  } finally {
    rmSync(tmpPath);
  }
}

describe('Config parser', () => {
  test('loads and validates ax.yaml', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.profile).toBe('paranoid');
    expect(config.providers.channels).toEqual([]);
    expect(config.sandbox.timeout_sec).toBe(120);
    expect(config.scheduler.active_hours.timezone).toBe('America/New_York');
  });

  test('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/path.yaml')).toThrow();
  });

  test('throws on invalid profile', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(['paranoid', 'balanced', 'yolo']).toContain(config.profile);
  });

  test('agent field defaults to pi-coding-agent when omitted', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.agent).toBe('pi-coding-agent');
  });

  test('accepts valid agent types', async () => {
    for (const agent of ['pi-coding-agent', 'claude-code'] as const) {
      await withTempConfig(`
agent: ${agent}
profile: balanced
`, (tmpPath) => {
        const config = loadConfig(tmpPath);
        expect(config.agent).toBe(agent);
      });
    }
  });

  test('rejects unknown agent type', async () => {
    await withTempConfig(`
agent: unknown-agent
profile: balanced
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow();
    });
  });

  test('accepts config with models map (default + fallbacks)', async () => {
    await withTempConfig(`
models:
  default:
    - groq/moonshotai/kimi-k2-instruct-0905
    - openrouter/anthropic/claude-sonnet-4
profile: balanced
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.models!.default).toEqual([
        'groq/moonshotai/kimi-k2-instruct-0905',
        'openrouter/anthropic/claude-sonnet-4',
      ]);
    });
  });

  test('accepts config with all task-type model chains', async () => {
    await withTempConfig(`
models:
  default:
    - anthropic/claude-sonnet-4-20250514
  fast:
    - anthropic/claude-haiku-4-5-20251001
  thinking:
    - anthropic/claude-opus-4-20250514
  coding:
    - anthropic/claude-sonnet-4-20250514
profile: balanced
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.models!.default).toEqual(['anthropic/claude-sonnet-4-20250514']);
      expect(config.models!.fast).toEqual(['anthropic/claude-haiku-4-5-20251001']);
      expect(config.models!.thinking).toEqual(['anthropic/claude-opus-4-20250514']);
      expect(config.models!.coding).toEqual(['anthropic/claude-sonnet-4-20250514']);
    });
  });

  test('config without models field still parses', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.profile).toBeDefined();
  });

  test('accepts valid webhooks config', async () => {
    await withTempConfig(`
profile: balanced
webhooks:
  enabled: true
  token: "test-secret-token"
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.webhooks).toEqual({
        enabled: true,
        token: 'test-secret-token',
      });
    });
  });

  test('accepts webhooks config with all optional fields', async () => {
    await withTempConfig(`
profile: balanced
webhooks:
  enabled: true
  token: "test-secret-token"
  path: "/hooks"
  max_body_bytes: 131072
  model: "claude-haiku-4-5-20251001"
  allowed_agent_ids:
    - "main"
    - "devops"
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.webhooks?.path).toBe('/hooks');
      expect(config.webhooks?.max_body_bytes).toBe(131072);
      expect(config.webhooks?.model).toBe('claude-haiku-4-5-20251001');
      expect(config.webhooks?.allowed_agent_ids).toEqual(['main', 'devops']);
    });
  });

  test('rejects webhooks config without token when enabled', async () => {
    await withTempConfig(`
profile: balanced
webhooks:
  enabled: true
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow();
    });
  });

  test('config without webhooks section parses fine', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.webhooks).toBeUndefined();
  });

  test('admin config defaults when not specified', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.admin).toEqual({
      enabled: true,
      port: 8080,
    });
  });

  test('accepts admin config from YAML', async () => {
    await withTempConfig(`
profile: balanced
admin:
  enabled: true
  token: "test-token-123"
  port: 9090
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.admin.enabled).toBe(true);
      expect(config.admin.token).toBe('test-token-123');
      expect(config.admin.port).toBe(9090);
    });
  });

  test('invalid provider name produces friendly error message', async () => {
    await withTempConfig(`
profile: balanced
providers:
  security: promptfoo
  audit: sqlite
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow(/providers\.security: "promptfoo" is not a valid option/);
      expect(() => loadConfig(tmpPath)).toThrow(/providers\.audit: "sqlite" is not a valid option/);
      expect(() => loadConfig(tmpPath)).toThrow(/Valid values: "patterns", "guardian", "none"/);
      expect(() => loadConfig(tmpPath)).toThrow(/Valid values: "database"/);
      expect(() => loadConfig(tmpPath)).toThrow(/Edit your config:/);
    });
  });

  test('accepts config with shared_agents section', async () => {
    await withTempConfig(`
profile: balanced
shared_agents:
  - id: backend-bot
    display_name: "Backend Team Bot"
    slack_bot_token_env: BACKEND_SLACK_BOT_TOKEN
    slack_app_token_env: BACKEND_SLACK_APP_TOKEN
    admins: ["U001", "U002"]
    capabilities: ["coding", "backend"]
    description: "Handles backend engineering tasks"
  - id: devops-bot
    display_name: "DevOps Bot"
    agent: claude-code
    models:
      default:
        - anthropic/claude-sonnet-4-20250514
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.shared_agents).toHaveLength(2);
      expect(config.shared_agents![0].id).toBe('backend-bot');
      expect(config.shared_agents![0].display_name).toBe('Backend Team Bot');
      expect(config.shared_agents![0].admins).toEqual(['U001', 'U002']);
      expect(config.shared_agents![1].id).toBe('devops-bot');
      expect(config.shared_agents![1].agent).toBe('claude-code');
    });
  });

  test('config without shared_agents parses fine', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.shared_agents).toBeUndefined();
  });

  test('rejects shared_agents with invalid id characters', async () => {
    await withTempConfig(`
profile: balanced
shared_agents:
  - id: "bad id with spaces"
    display_name: "Bad Bot"
`, (tmpPath) => {
      expect(() => loadConfig(tmpPath)).toThrow();
    });
  });

  test('accepts config with security provider', async () => {
    await withTempConfig(`
profile: balanced
providers:
  security: patterns
`, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.providers.security).toBe('patterns');
    });
  });

  // ── Provider defaults ──

  test('minimal config gets all provider defaults', async () => {
    await withTempConfig(MINIMAL_CONFIG, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.providers.memory).toBe('cortex');
      expect(config.providers.security).toBe('patterns');
      expect(config.providers.channels).toEqual([]);
      expect(config.providers.web).toEqual({ extract: 'none', search: 'none' });
      expect(config.providers.audit).toBe('database');
      expect(config.providers.scheduler).toBe('plainjob');
      expect(config.providers.database).toBe('sqlite');
      expect(config.providers.storage).toBe('database');
      expect(config.providers.eventbus).toBe('inprocess');
      expect(config.providers.workspace).toBe('git-local');
    });
  });

  test('minimal config gets sandbox defaults', async () => {
    await withTempConfig(MINIMAL_CONFIG, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.sandbox.timeout_sec).toBe(120);
      expect(config.sandbox.memory_mb).toBe(512);
    });
  });

  test('minimal config gets scheduler defaults', async () => {
    await withTempConfig(MINIMAL_CONFIG, (tmpPath) => {
      const config = loadConfig(tmpPath);
      expect(config.scheduler.active_hours.start).toBe('07:00');
      expect(config.scheduler.max_token_budget).toBe(4096);
      expect(config.scheduler.heartbeat_interval_min).toBe(30);
    });
  });
});
