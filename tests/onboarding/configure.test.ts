import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildInquirerDefaults } from '../../src/onboarding/configure.js';
import { runOnboarding, loadExistingConfig } from '../../src/onboarding/wizard.js';

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
    expect(defaults.agent).toBeUndefined();
    expect(defaults.apiKey).toBeUndefined();
    expect(defaults.channels).toBeUndefined();
  });

  test('buildInquirerDefaults maps existing config to inquirer defaults', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-existing',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.profile).toBe('yolo');
    expect(defaults.apiKey).toBe('sk-existing');
    expect(defaults.channels).toEqual(['slack']);
  });

  test('buildInquirerDefaults masks API key for display', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-ant-api03-longkeyvalue12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    // apiKey is the full value (for pre-filling the input),
    // but apiKeyMasked is a display hint
    expect(defaults.apiKey).toBe('sk-ant-api03-longkeyvalue12345');
    expect(defaults.apiKeyMasked).toMatch(/^sk-\.\.\..+$/);
  });

  test('buildInquirerDefaults includes passphrase and tavily key from existing config', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-test-key',
        channels: ['cli'],
        skipSkills: true,
        credsPassphrase: 'my-passphrase',
        webSearchApiKey: 'tvly-long-api-key-value',
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.credsPassphrase).toBe('my-passphrase');
    expect(defaults.webSearchApiKey).toBe('tvly-long-api-key-value');
    expect(defaults.webSearchApiKeyMasked).toMatch(/^tvl\.\.\..+$/);
  });

  test('buildInquirerDefaults includes agent type from existing config', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'claude-code',
        apiKey: 'sk-test-key',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    const defaults = buildInquirerDefaults(existing);

    expect(defaults.agent).toBe('claude-code');
  });
});
