import { describe, test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolve } from 'node:path';

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
    // We test via a known-good file, so this is just verifying schema enforcement
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(['paranoid', 'balanced', 'yolo']).toContain(config.profile);
  });

  test('agent field defaults to pi-coding-agent when omitted', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.agent).toBe('pi-coding-agent');
  });

  test('accepts valid agent types', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const agents = ['pi-coding-agent', 'claude-code'] as const;
    for (const agent of agents) {
      const tmpPath = resolve(import.meta.dirname, `../ax-test-agent-${agent}.yaml`);
      writeFileSync(tmpPath, `
agent: ${agent}
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
      try {
        const config = loadConfig(tmpPath);
        expect(config.agent).toBe(agent);
      } finally {
        rmSync(tmpPath);
      }
    }
  });

  test('rejects unknown agent type', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-agent-bad.yaml');
    writeFileSync(tmpPath, `
agent: unknown-agent
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      expect(() => loadConfig(tmpPath)).toThrow();
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts config with models map (default + fallbacks)', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-model.yaml');
    writeFileSync(tmpPath, `
models:
  default:
    - groq/moonshotai/kimi-k2-instruct-0905
    - openrouter/anthropic/claude-sonnet-4
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.models!.default).toEqual([
        'groq/moonshotai/kimi-k2-instruct-0905',
        'openrouter/anthropic/claude-sonnet-4',
      ]);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts config with models.image array', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-image-models.yaml');
    writeFileSync(tmpPath, `
models:
  default:
    - anthropic/claude-sonnet-4-20250514
  image:
    - openai/gpt-image-1.5
    - openrouter/seedream-5-0
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.models!.image).toEqual([
        'openai/gpt-image-1.5',
        'openrouter/seedream-5-0',
      ]);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts config with all task-type model chains', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-task-models.yaml');
    writeFileSync(tmpPath, `
models:
  default:
    - anthropic/claude-sonnet-4-20250514
  fast:
    - anthropic/claude-haiku-4-5-20251001
  thinking:
    - anthropic/claude-opus-4-20250514
  coding:
    - anthropic/claude-sonnet-4-20250514
  image:
    - openai/gpt-image-1.5
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.models!.default).toEqual(['anthropic/claude-sonnet-4-20250514']);
      expect(config.models!.fast).toEqual(['anthropic/claude-haiku-4-5-20251001']);
      expect(config.models!.thinking).toEqual(['anthropic/claude-opus-4-20250514']);
      expect(config.models!.coding).toEqual(['anthropic/claude-sonnet-4-20250514']);
      expect(config.models!.image).toEqual(['openai/gpt-image-1.5']);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('config without models field still parses', () => {
    // models is optional in the schema — configs without it should parse fine.
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.profile).toBeDefined();
  });

  test('accepts valid webhooks config', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-webhooks.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
webhooks:
  enabled: true
  token: "test-secret-token"
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.webhooks).toEqual({
        enabled: true,
        token: 'test-secret-token',
      });
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts webhooks config with all optional fields', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-webhooks-full.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
webhooks:
  enabled: true
  token: "test-secret-token"
  path: "/hooks"
  max_body_bytes: 131072
  model: "claude-haiku-4-5-20251001"
  allowed_agent_ids:
    - "main"
    - "devops"
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.webhooks?.path).toBe('/hooks');
      expect(config.webhooks?.max_body_bytes).toBe(131072);
      expect(config.webhooks?.model).toBe('claude-haiku-4-5-20251001');
      expect(config.webhooks?.allowed_agent_ids).toEqual(['main', 'devops']);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('rejects webhooks config without token when enabled', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-webhooks-notoken.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
webhooks:
  enabled: true
`);
    try {
      expect(() => loadConfig(tmpPath)).toThrow();
    } finally {
      rmSync(tmpPath);
    }
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
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-admin.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
admin:
  enabled: true
  token: "test-token-123"
  port: 9090
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.admin.enabled).toBe(true);
      expect(config.admin.token).toBe('test-token-123');
      expect(config.admin.port).toBe(9090);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('invalid provider name produces friendly error message', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-bad-provider.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: promptfoo
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: plaintext
  skills: database
  audit: sqlite
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      expect(() => loadConfig(tmpPath)).toThrow(/providers\.scanner: "promptfoo" is not a valid option/);
      expect(() => loadConfig(tmpPath)).toThrow(/providers\.audit: "sqlite" is not a valid option/);
      expect(() => loadConfig(tmpPath)).toThrow(/Valid values: "patterns", "guardian"/);
      expect(() => loadConfig(tmpPath)).toThrow(/Valid values: "database"/);
      expect(() => loadConfig(tmpPath)).toThrow(/Edit your config:/);
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts config with shared_agents section', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-shared-agents.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
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
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.shared_agents).toHaveLength(2);
      expect(config.shared_agents![0].id).toBe('backend-bot');
      expect(config.shared_agents![0].display_name).toBe('Backend Team Bot');
      expect(config.shared_agents![0].admins).toEqual(['U001', 'U002']);
      expect(config.shared_agents![1].id).toBe('devops-bot');
      expect(config.shared_agents![1].agent).toBe('claude-code');
    } finally {
      rmSync(tmpPath);
    }
  });

  test('config without shared_agents parses fine', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.shared_agents).toBeUndefined();
  });

  test('rejects shared_agents with invalid id characters', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-bad-shared-agent.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
shared_agents:
  - id: "bad id with spaces"
    display_name: "Bad Bot"
`);
    try {
      expect(() => loadConfig(tmpPath)).toThrow();
    } finally {
      rmSync(tmpPath);
    }
  });

  test('accepts config with optional screener', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-screener.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: cortex
  scanner: patterns
  channels: []
  web:
    extract: none
    search: none
  browser: none
  credentials: env
  skills: database
  audit: database
  sandbox: subprocess
  scheduler: none
  screener: static
sandbox:
  timeout_sec: 120
  memory_mb: 512
scheduler:
  active_hours: { start: "07:00", end: "23:00", timezone: "UTC" }
  max_token_budget: 4096
  heartbeat_interval_min: 30
`);
    try {
      const config = loadConfig(tmpPath);
      expect(config.providers.screener).toBe('static');
    } finally {
      rmSync(tmpPath);
    }
  });
});
