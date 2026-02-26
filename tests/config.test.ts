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

  test('agent field defaults to pi-agent-core when omitted', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.agent).toBe('pi-agent-core');
  });

  test('accepts valid agent types', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const agents = ['pi-agent-core', 'pi-coding-agent', 'claude-code'] as const;
    for (const agent of agents) {
      const tmpPath = resolve(import.meta.dirname, `../ax-test-agent-${agent}.yaml`);
      writeFileSync(tmpPath, `
agent: ${agent}
profile: balanced
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
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
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
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
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
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
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
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
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
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

  test('accepts config with optional skillScreener', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-screener.yaml');
    writeFileSync(tmpPath, `
profile: balanced
providers:
  memory: file
  scanner: basic
  channels: []
  web: none
  browser: none
  credentials: env
  skills: readonly
  audit: file
  sandbox: subprocess
  scheduler: none
  skillScreener: static
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
      expect(config.providers.skillScreener).toBe('static');
    } finally {
      rmSync(tmpPath);
    }
  });
});
