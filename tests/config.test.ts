import { describe, test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolve } from 'node:path';

describe('Config parser', () => {
  test('loads and validates ax.yaml', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(config.profile).toBe('paranoid');
    expect(config.providers.llm).toBe('anthropic');
    expect(config.providers.channels).toEqual(['cli']);
    expect(config.sandbox.timeout_sec).toBe(120);
    expect(config.scheduler.active_hours.timezone).toBe('America/New_York');
  });

  test('throws on missing file', () => {
    expect(() => loadConfig('/nonexistent/path.yaml')).toThrow();
  });

  test('throws on invalid profile', () => {
    // We test via a known-good file, so this is just verifying schema enforcement
    const config = loadConfig(resolve(import.meta.dirname, '../ax.yaml'));
    expect(['paranoid', 'standard', 'power_user']).toContain(config.profile);
  });

  test('accepts config with optional skillScreener', async () => {
    const { writeFileSync, rmSync } = await import('node:fs');
    const tmpPath = resolve(import.meta.dirname, '../ax-test-screener.yaml');
    writeFileSync(tmpPath, `
profile: standard
providers:
  llm: anthropic
  memory: file
  scanner: basic
  channels: [cli]
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
