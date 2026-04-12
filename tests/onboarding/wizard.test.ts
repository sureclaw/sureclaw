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
    expect(config.providers.security).toBe('patterns');
    expect(config.providers.web).toEqual({ extract: 'none', search: 'none' });

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
    expect(config.providers.web).toEqual({ extract: 'none', search: 'none' });

    expect(config.providers.memory).toBe('cortex');
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

    expect(config.providers.credentials).toBe('keychain');
  });

  // ── API key handling ──

  test('saves API key to credentials.yaml', async () => {
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

    const credsPath = join(dir, 'credentials.yaml');
    expect(existsSync(credsPath)).toBe(true);
    const creds = parseYaml(readFileSync(credsPath, 'utf-8'));
    expect(creds.ANTHROPIC_API_KEY).toBe('sk-ant-api-key-here');
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

  // ── security provider across profiles ──

  test('paranoid profile uses patterns security', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'paranoid', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.security).toBe('patterns');
  });

  test('balanced profile uses patterns security', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: { profile: 'balanced', apiKey: 'sk-test', channels: ['cli'], skipSkills: true },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.security).toBe('patterns');
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
    expect(existing!.channels).toEqual(['slack']);
  });

  test('loadExistingConfig returns null when no config exists', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    const existing = loadExistingConfig(dir);
    expect(existing).toBeNull();
  });

  test('loadExistingConfig reads API key from credentials.yaml', async () => {
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

  // ── Preserve passphrase and Tavily key on reconfigure ──

  test('loadExistingConfig reads Tavily key from credentials.yaml', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'yolo',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
        webSearchApiKey: 'tvly-test-key-123',
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.webSearchApiKey).toBe('tvly-test-key-123');
  });

  // ── Agent type ──

  test('runOnboarding writes agent field to ax.yaml', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'claude-code',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.agent).toBe('claude-code');
  });

  test('runOnboarding defaults agent to profile default when not specified', async () => {
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

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.agent).toBe('pi-coding-agent');
  });

  test('loadExistingConfig reads agent from ax.yaml', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        apiKey: 'sk-test',
        channels: ['cli'],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.agent).toBe('pi-coding-agent');
  });

  // ── Empty channels (CLI-only) ──

  test('supports empty channels array for CLI-only usage', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: [],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.providers.channels).toEqual([]);
  });

  // ── OAuth tokens ──

  test('writes OAuth tokens to credentials.yaml when oauthToken is set', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: '',
        oauthToken: 'sk-ant-oat01-test-token',
        oauthRefreshToken: 'sk-ant-ort01-test-refresh',
        oauthExpiresAt: 1739184000,
        channels: [],
        skipSkills: true,
      },
    });

    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
    expect(creds.AX_OAUTH_REFRESH_TOKEN).toBe('sk-ant-ort01-test-refresh');
    expect(creds.AX_OAUTH_EXPIRES_AT).toBe('1739184000');
    // Should NOT contain ANTHROPIC_API_KEY when OAuth is used
    expect(creds.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('writes ANTHROPIC_API_KEY when no OAuth token', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-ant-api03-test',
        channels: [],
        skipSkills: true,
      },
    });

    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.ANTHROPIC_API_KEY).toBe('sk-ant-api03-test');
    expect(creds.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  test('loadExistingConfig reads OAuth tokens from credentials.yaml', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: '',
        oauthToken: 'sk-ant-oat01-saved',
        oauthRefreshToken: 'sk-ant-ort01-saved',
        oauthExpiresAt: 1739200000,
        channels: [],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.authMethod).toBe('oauth');
    expect(existing!.oauthToken).toBe('sk-ant-oat01-saved');
    expect(existing!.oauthRefreshToken).toBe('sk-ant-ort01-saved');
    expect(existing!.oauthExpiresAt).toBe(1739200000);
  });

  test('loadExistingConfig detects api-key auth method when no OAuth token', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-ant-api03-test',
        channels: [],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.authMethod).toBe('api-key');
    expect(existing!.oauthToken).toBeUndefined();
  });

  // ── Slack token handling ──

  test('writes Slack tokens to credentials.yaml when slack channel selected', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['slack'],
        skipSkills: true,
        slackBotToken: 'xoxb-test-bot-token',
        slackAppToken: 'xapp-test-app-token',
      },
    });

    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.SLACK_BOT_TOKEN).toBe('xoxb-test-bot-token');
    expect(creds.SLACK_APP_TOKEN).toBe('xapp-test-app-token');
  });

  test('does not write Slack tokens when no slack channel', async () => {
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

    // credentials.yaml should still exist (has API key) but without Slack tokens
    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.SLACK_BOT_TOKEN).toBeUndefined();
    expect(creds.SLACK_APP_TOKEN).toBeUndefined();
  });

  test('loadExistingConfig reads Slack tokens from credentials.yaml', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['slack'],
        skipSkills: true,
        slackBotToken: 'xoxb-saved-bot',
        slackAppToken: 'xapp-saved-app',
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.slackBotToken).toBe('xoxb-saved-bot');
    expect(existing!.slackAppToken).toBe('xapp-saved-app');
  });

  // ── channel_config generation ──

  test('generates channel_config for slack channel', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['slack'],
        skipSkills: true,
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.channel_config).toBeDefined();
    expect(config.channel_config.slack).toBeDefined();
    expect(config.channel_config.slack.dm_policy).toBe('open');
    expect(config.channel_config.slack.require_mention).toBe(true);
  });

  test('omits channel_config when no channels need it', async () => {
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

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.channel_config).toBeUndefined();
  });

  // ── Generated config passes Zod validation ──

  test('generated config with channel_config passes loadConfig validation', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        apiKey: 'sk-test',
        channels: ['slack'],
        skipSkills: true,
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
      },
    });

    const config = loadConfig(join(dir, 'ax.yaml'));
    expect(config.channel_config).toBeDefined();
    expect(config.channel_config!.slack).toBeDefined();
  });

  // ── Model selection (compound provider/model ID) ──

  test('writes model to ax.yaml for router-based agent', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        apiKey: 'sk-test',
        channels: [],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.models).toEqual({ default: ['anthropic/claude-sonnet-4-20250514'] });
  });

  test('omits models from ax.yaml for claude-code agent', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'claude-code',
        apiKey: 'sk-test',
        channels: [],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.models).toBeUndefined();
  });

  test('writes provider-specific API key for non-anthropic provider', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'openrouter/anthropic/claude-sonnet-4',
        llmProvider: 'openrouter',
        apiKey: 'or-key-123456', // gitleaks:allow
        channels: [],
        skipSkills: true,
      },
    });

    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.OPENROUTER_API_KEY).toBe('or-key-123456'); // gitleaks:allow
    expect(creds.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test('writes ANTHROPIC_API_KEY for anthropic llmProvider', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        llmProvider: 'anthropic',
        apiKey: 'sk-ant-test-key',
        channels: [],
        skipSkills: true,
      },
    });

    const creds = parseYaml(readFileSync(join(dir, 'credentials.yaml'), 'utf-8'));
    expect(creds.ANTHROPIC_API_KEY).toBe('sk-ant-test-key');
  });

  test('does not write empty API key to credentials.yaml', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'groq/llama-3.3-70b-versatile',
        llmProvider: 'groq',
        apiKey: '',
        channels: [],
        skipSkills: true,
      },
    });

    // No credentials to write → credentials.yaml should not exist
    expect(existsSync(join(dir, 'credentials.yaml'))).toBe(false);
  });

  test('loadExistingConfig reads model and derives llmProvider', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'openrouter/gpt-4.1',
        llmProvider: 'openrouter',
        apiKey: 'or-key-test',
        channels: [],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing).not.toBeNull();
    expect(existing!.model).toBe('openrouter/gpt-4.1');
    expect(existing!.llmProvider).toBe('openrouter');
  });

  test('loadExistingConfig reads non-Anthropic API key from credentials.yaml', async () => {
    const { loadExistingConfig } = await import('../../src/onboarding/wizard.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'groq/llama-3.3-70b-versatile',
        llmProvider: 'groq',
        apiKey: 'gsk-test-key-value',
        channels: [],
        skipSkills: true,
      },
    });

    const existing = loadExistingConfig(dir);
    expect(existing!.apiKey).toBe('gsk-test-key-value');
    expect(existing!.llmProvider).toBe('groq');
  });

  test('omits models when no model set', async () => {
    const dir = setup();
    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'claude-code',
        apiKey: 'sk-test',
        channels: [],
        skipSkills: true,
      },
    });

    const config = parseYaml(readFileSync(join(dir, 'ax.yaml'), 'utf-8'));
    expect(config.models).toBeUndefined();
  });

  test('generated config with model passes loadConfig validation', async () => {
    const { loadConfig } = await import('../../src/config.js');
    const dir = setup();

    await runOnboarding({
      outputDir: dir,
      answers: {
        profile: 'balanced',
        agent: 'pi-coding-agent',
        model: 'anthropic/claude-sonnet-4-20250514',
        apiKey: 'sk-test',
        channels: [],
        skipSkills: true,
      },
    });

    const config = loadConfig(join(dir, 'ax.yaml'));
    expect(config.models).toEqual({ default: ['anthropic/claude-sonnet-4-20250514'] });
    expect(config.agent).toBe('pi-coding-agent');
  });
});
