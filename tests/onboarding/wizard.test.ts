import { describe, test, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runOnboarding } from '../../src/onboarding/wizard.js';
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
      answers: {
        profile: 'paranoid',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const configPath = join(dir, 'ax.yaml');
    expect(existsSync(configPath)).toBe(true);

    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.profile).toBe('paranoid');
    expect(config.providers.llm).toBe('anthropic');
    expect(config.providers.scanner).toBe('patterns');
    expect(config.providers.web).toBe('none');
    expect(config.providers.skills).toBe('readonly');
    expect(config.providers.channels).toEqual(['cli']);
  });

  test('generates valid ax.yaml for balanced profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('balanced');
    expect(config.providers.web).toBe('fetch');
    expect(config.providers.skills).toBe('git');
    expect(config.providers.memory).toBe('sqlite');
  });

  test('generates valid ax.yaml for yolo profile', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-test-key-12345',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.profile).toBe('yolo');
    expect(config.providers.skills).toBe('git');
    expect(config.providers.browser).toBe('container');
    expect(config.providers.credentials).toBe('encrypted');
  });

  // ── API key handling ──

  test('saves API key to .env file', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-ant-api-key-here',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const envPath = join(dir, '.env');
    expect(existsSync(envPath)).toBe(true);
    const envContent = readFileSync(envPath, 'utf-8');
    expect(envContent).toContain('ANTHROPIC_API_KEY=sk-ant-api-key-here');
  });

  // ── YAML validity ──

  test('generated config has valid structure', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const raw = readFileSync(join(dir, 'ax.yaml'), 'utf-8');
    const parsed = parseYaml(raw);
    expect(parsed.sandbox.timeout_sec).toBeGreaterThan(0);
    expect(parsed.sandbox.memory_mb).toBeGreaterThan(0);
    expect(parsed.scheduler.active_hours.start).toMatch(/^\d{2}:\d{2}$/);
    expect(parsed.scheduler.active_hours.end).toMatch(/^\d{2}:\d{2}$/);
    expect(parsed.scheduler.max_token_budget).toBeGreaterThan(0);
    expect(parsed.scheduler.heartbeat_interval_min).toBeGreaterThan(0);
  });

  // ── Multiple channels ──

  test('supports multiple channels', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.channels).toEqual(['cli', 'slack']);
  });

  // ── skillScreener only on profiles that support it ──

  test('paranoid profile omits skillScreener', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'paranoid', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.skillScreener).toBeUndefined();
  });

  test('balanced profile includes skillScreener', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.skillScreener).toBe('static');
  });

  // ── Invalid profile ──

  test('throws on unknown profile', async () => {
    const dir = setup();
    await expect(
      runOnboarding({
        outputDir: dir,
        answers: { profile: 'invalid' as any, apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
      }),
    ).rejects.toThrow('Unknown profile');
  });

  // ── Skill install queue ──

  test('writes .clawhub-install-queue when skills requested', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: false,
        installSkills: ['daily-standup', 'code-review'],
      },
    });

    const queuePath = join(dir, '.clawhub-install-queue');
    expect(existsSync(queuePath)).toBe(true);
    const content = readFileSync(queuePath, 'utf-8');
    expect(content).toContain('daily-standup');
    expect(content).toContain('code-review');
  });

  test('skips .clawhub-install-queue when skipSkills is true', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
        installSkills: ['daily-standup'],
      },
    });

    expect(existsSync(join(dir, '.clawhub-install-queue'))).toBe(false);
  });

  // ── Reconfigure: loads existing config as defaults ──

  test('loadExistingConfig reads ax.yaml into OnboardingAnswers', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    // Generate a config first
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-existing-key',
        channels: ['cli', 'slack'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.profile).toBe('yolo');
    expect(existing!.channels).toEqual(['cli', 'slack']);
  });

  test('loadExistingConfig returns null when no config exists', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    const existing = loadExistingConfig(dir);
    expect(existing).toBeNull();
  });

  test('loadExistingConfig reads API key from .env', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-my-saved-key',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.apiKey).toBe('sk-my-saved-key');
  });
});
