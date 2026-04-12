import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildInquirerDefaults } from '../../src/onboarding/configure.js';
import { runOnboarding, loadExistingConfig, loadExistingApiKey } from '../../src/onboarding/wizard.js';

describe('Configure UI Helpers', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function setup(): string {
    tmpDir = join(tmpdir(), `configure-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  test('buildInquirerDefaults returns undefined values when no existing config', () => {
    const defaults = buildInquirerDefaults(null);
    expect(defaults.profile).toBeUndefined();
    expect(defaults.apiKey).toBeUndefined();
    expect(defaults.model).toBeUndefined();
    expect(defaults.llmProvider).toBeUndefined();
  });

  test('buildInquirerDefaults maps existing config to inquirer defaults', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'yolo', apiKey: 'sk-existing' },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.profile).toBe('yolo');
  });

  test('loadExistingApiKey retrieves stored API key', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-ant-api03-longkeyvalue12345' },
    });

    const key = await loadExistingApiKey(dir);
    expect(key).toBe('sk-ant-api03-longkeyvalue12345');
  });

  test('buildInquirerDefaults includes model and llmProvider from existing config', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        model: 'openrouter/anthropic/claude-sonnet-4',
        llmProvider: 'openrouter',
        apiKey: 'or-key-test-value',
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.model).toBe('openrouter/anthropic/claude-sonnet-4');
    expect(defaults.llmProvider).toBe('openrouter');
  });

  test('buildInquirerDefaults returns undefined model when no existing config', () => {
    const defaults = buildInquirerDefaults(null);
    expect(defaults.model).toBeUndefined();
    expect(defaults.llmProvider).toBeUndefined();
  });
});
