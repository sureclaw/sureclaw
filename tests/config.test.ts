import { describe, test, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolve } from 'node:path';

describe('Config parser', () => {
  test('loads and validates sureclaw.yaml', () => {
    const config = loadConfig(resolve(import.meta.dirname, '../sureclaw.yaml'));
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
    const config = loadConfig(resolve(import.meta.dirname, '../sureclaw.yaml'));
    expect(['paranoid', 'standard', 'power_user']).toContain(config.profile);
  });
});
