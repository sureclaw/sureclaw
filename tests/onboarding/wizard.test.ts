import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runOnboarding, loadExistingApiKey } from '../../src/onboarding/wizard.js';
import { parse as parseYaml } from 'yaml';

describe('Onboarding Wizard', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = join(tmpdir(), `onboard-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  // ── Profile → config generation ──

  test('generates valid ax.yaml for paranoid profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'paranoid', apiKey: 'sk-test-key-12345' },
    });

    const configPath = join(dir, 'ax.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.profile).toBe('paranoid');
    // Sandbox config is no longer written to ax.yaml — Zod defaults apply at load time
    expect(config.sandbox).toBeUndefined();
  });

  test('generates valid ax.yaml for balanced profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-test-key-12345' },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('balanced');
    expect(config.sandbox).toBeUndefined();
  });

  test('generates valid ax.yaml for yolo profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'yolo', apiKey: 'sk-test-key-12345' },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('yolo');
    expect(config.sandbox).toBeUndefined();
  });

  // ── Minimal config — no providers block ──

  test('generated config is minimal — no providers block', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-test' },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers).toBeUndefined();
  });

  // ── API key handling ──

  test('saves API key to database', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-ant-api-key-here' },
    });

    const key = await loadExistingApiKey(dir);
    expect(key).toBe('sk-ant-api-key-here');
  });

  test('writes provider-specific API key for non-anthropic provider', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        model: 'openrouter/anthropic/claude-sonnet-4',
        llmProvider: 'openrouter',
        apiKey: 'or-key-123456', // gitleaks:allow
      },
    });

    const orKey = await loadExistingApiKey(dir, 'openrouter');
    expect(orKey).toBe('or-key-123456'); // gitleaks:allow
    const anthKey = await loadExistingApiKey(dir);
    expect(anthKey).toBe('');
  });

  test('does not write empty API key to database', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: '' },
    });

    // No database file should be created for empty key
    const key = await loadExistingApiKey(dir);
    expect(key).toBe('');
  });

  // ── Model selection ──

  test('writes model to ax.yaml', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        model: 'anthropic/claude-sonnet-4-20250514',
        apiKey: 'sk-test',
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.models).toEqual({ default: ['anthropic/claude-sonnet-4-20250514'] });
  });

  test('omits models when no model set', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-test' },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.models).toBeUndefined();
  });

  // ── Invalid profile ──

  test('throws on unknown profile', async () => {
    const dir = setup();
    await expect(
      runOnboarding({
        outputDir: dir,
        answers: { profile: 'invalid' as any, apiKey: 'sk-test' },
      }),
    ).rejects.toThrow('Unknown profile');
  });

  // ── Generated config passes loadConfig ──

  test('generated config with model passes loadConfig validation', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        model: 'anthropic/claude-sonnet-4-20250514',
        apiKey: 'sk-test',
      },
    });

    const config = loadConfig(join(dir, 'ax.yaml'));
    expect(config.models).toEqual({ default: ['anthropic/claude-sonnet-4-20250514'] });
    expect(config.providers.sandbox).toBeDefined();
    expect(config.providers.workspace).toBe('git-local');
  });

  test('minimal config (profile only) passes loadConfig validation', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: '' },
    });

    const config = loadConfig(join(dir, 'ax.yaml'));
    expect(config.profile).toBe('balanced');
    expect(config.providers.database).toBe('sqlite');
    expect(config.providers.eventbus).toBe('inprocess');
    expect(config.providers.workspace).toBe('git-local');
    expect(config.providers.memory).toBe('cortex');
    expect(config.providers.security).toBe('patterns');
    expect(config.providers.credentials).toBe('database');
  });

  // ── Reconfigure: loads existing config as defaults ──

  test('loadExistingConfig reads ax.yaml into OnboardingAnswers', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'yolo', apiKey: 'sk-existing-key' },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.profile).toBe('yolo');
  });

  test('loadExistingConfig returns null when no config exists', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    const existing = loadExistingConfig(dir);
    expect(existing).toBeNull();
  });

  test('loadExistingApiKey reads API key from database', async () => {
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-my-saved-key' },
    });

    const key = await loadExistingApiKey(dir);
    expect(key).toBe('sk-my-saved-key');
  });

  test('loadExistingConfig reads model and derives llmProvider', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        model: 'openrouter/gpt-4.1',
        llmProvider: 'openrouter',
        apiKey: 'or-key-test',
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.model).toBe('openrouter/gpt-4.1');
    expect(existing!.llmProvider).toBe('openrouter');
  });
});
