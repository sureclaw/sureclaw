/**
 * Onboarding wizard — generates ax.yaml from answers.
 *
 * Two modes:
 * - Programmatic: call runOnboarding() with OnboardingOptions (for tests and automation)
 * - Interactive: call runConfigure() for terminal-based setup via @inquirer/prompts
 *
 * Supports reconfiguration: loadExistingConfig() reads the current config
 * so the interactive UI can pre-fill answers.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';
import { PROFILE_DEFAULTS } from './prompts.js';
import type { ProfileName, AgentType } from './prompts.js';

export interface OnboardingAnswers {
  profile: ProfileName;
  agent?: AgentType;
  authMethod?: 'api-key' | 'oauth';
  apiKey: string;
  oauthToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
  channels: string[];
  skipSkills?: boolean;
  installSkills?: string[];
  credsPassphrase?: string;
  webProvider?: string;
  webSearchApiKey?: string;
  slackBotToken?: string;
  slackAppToken?: string;
}

export interface OnboardingOptions {
  outputDir: string;
  answers: OnboardingAnswers;
}

export async function runOnboarding(opts: OnboardingOptions): Promise<void> {
  const { outputDir, answers } = opts;
  const defaults = PROFILE_DEFAULTS[answers.profile];

  if (!defaults) {
    throw new Error(`Unknown profile: "${answers.profile}"`);
  }

  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Build providers object — only include skillScreener if the profile defines one
  const providers: Record<string, unknown> = {
    llm: defaults.llm,
    memory: defaults.memory,
    scanner: defaults.scanner,
    channels: answers.channels,
    web: answers.webProvider || defaults.web,
    browser: defaults.browser,
    credentials: defaults.credentials,
    skills: defaults.skills,
    audit: defaults.audit,
    sandbox: defaults.sandbox,
    scheduler: defaults.scheduler,
  };

  if (defaults.skillScreener) {
    providers.skillScreener = defaults.skillScreener;
  }

  // Build channel_config for selected channels
  const channelConfig: Record<string, Record<string, unknown>> = {};
  if (answers.channels.includes('slack')) {
    channelConfig.slack = {
      dm_policy: 'open',
      require_mention: true,
    };
  }

  // Build full config
  const config: Record<string, unknown> = {
    agent: answers.agent ?? defaults.agent,
    profile: answers.profile,
    providers,
    ...(Object.keys(channelConfig).length > 0 ? { channel_config: channelConfig } : {}),
    sandbox: {
      timeout_sec: defaults.timeoutSec,
      memory_mb: defaults.memoryMb,
    },
    scheduler: {
      active_hours: {
        start: '07:00',
        end: '23:00',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      },
      max_token_budget: 4096,
      heartbeat_interval_min: 30,
    },
  };

  // Write ax.yaml
  const yamlContent = yamlStringify(config, { indent: 2, lineWidth: 120 });
  writeFileSync(join(outputDir, 'ax.yaml'), yamlContent, 'utf-8');

  // Write .env — OAuth tokens or API key (they're separate auth methods)
  let envContent = '# AX Configuration\n';
  if (answers.oauthToken) {
    envContent += `\n# Claude Max OAuth tokens\nCLAUDE_CODE_OAUTH_TOKEN=${answers.oauthToken}\nAX_OAUTH_REFRESH_TOKEN=${answers.oauthRefreshToken || ''}\nAX_OAUTH_EXPIRES_AT=${answers.oauthExpiresAt || ''}\n`;
  } else {
    envContent += `ANTHROPIC_API_KEY=${answers.apiKey.trim()}\n`;
  }
  if (answers.credsPassphrase) {
    envContent += `\n# Encrypted credential store passphrase\nAX_CREDS_PASSPHRASE=${answers.credsPassphrase.trim()}\n`;
  }
  if (answers.webSearchApiKey) {
    envContent += `\n# Web search API key\nTAVILY_API_KEY=${answers.webSearchApiKey.trim()}\n`;
  }
  if (answers.slackBotToken) {
    envContent += `\n# Slack tokens\nSLACK_BOT_TOKEN=${answers.slackBotToken.trim()}\n`;
    if (answers.slackAppToken) {
      envContent += `SLACK_APP_TOKEN=${answers.slackAppToken.trim()}\n`;
    }
  }
  writeFileSync(join(outputDir, '.env'), envContent, 'utf-8');

  // Write ClawHub skill install queue if requested
  if (answers.installSkills && answers.installSkills.length > 0 && !answers.skipSkills) {
    const skillListContent = answers.installSkills.join('\n');
    writeFileSync(join(outputDir, '.clawhub-install-queue'), skillListContent, 'utf-8');
  }
}

/**
 * Load existing config from a directory, returning OnboardingAnswers
 * or null if no config exists. Used by the interactive configure UI
 * to pre-fill default selections.
 */
export function loadExistingConfig(dir: string): OnboardingAnswers | null {
  const cfgPath = join(dir, 'ax.yaml');
  if (!existsSync(cfgPath)) return null;

  try {
    const raw = readFileSync(cfgPath, 'utf-8');
    const parsed = parseYaml(raw);

    // Read secrets from .env if it exists
    let apiKey = '';
    let credsPassphrase: string | undefined;
    let webSearchApiKey: string | undefined;
    let oauthToken: string | undefined;
    let oauthRefreshToken: string | undefined;
    let oauthExpiresAt: number | undefined;
    let authMethod: 'api-key' | 'oauth' | undefined;
    let slackBotToken: string | undefined;
    let slackAppToken: string | undefined;
    const envFilePath = join(dir, '.env');
    if (existsSync(envFilePath)) {
      const envContent = readFileSync(envFilePath, 'utf-8');
      const apiKeyMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (apiKeyMatch) apiKey = apiKeyMatch[1].trim();
      const passphraseMatch = envContent.match(/^AX_CREDS_PASSPHRASE=(.+)$/m);
      if (passphraseMatch) credsPassphrase = passphraseMatch[1].trim();
      const tavilyMatch = envContent.match(/^TAVILY_API_KEY=(.+)$/m);
      if (tavilyMatch) webSearchApiKey = tavilyMatch[1].trim();
      const oauthTokenMatch = envContent.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
      if (oauthTokenMatch) oauthToken = oauthTokenMatch[1].trim();
      const oauthRefreshMatch = envContent.match(/^AX_OAUTH_REFRESH_TOKEN=(.+)$/m);
      if (oauthRefreshMatch) oauthRefreshToken = oauthRefreshMatch[1].trim();
      const oauthExpiresMatch = envContent.match(/^AX_OAUTH_EXPIRES_AT=(.+)$/m);
      if (oauthExpiresMatch) oauthExpiresAt = parseInt(oauthExpiresMatch[1].trim(), 10);
      authMethod = oauthToken ? 'oauth' : 'api-key';
      const slackBotMatch = envContent.match(/^SLACK_BOT_TOKEN=(.+)$/m);
      if (slackBotMatch) slackBotToken = slackBotMatch[1].trim();
      const slackAppMatch = envContent.match(/^SLACK_APP_TOKEN=(.+)$/m);
      if (slackAppMatch) slackAppToken = slackAppMatch[1].trim();
    }

    return {
      profile: parsed.profile ?? 'balanced',
      agent: parsed.agent,
      authMethod,
      apiKey,
      oauthToken,
      oauthRefreshToken,
      oauthExpiresAt,
      channels: (parsed.providers?.channels ?? []).filter((c: string) => c !== 'cli'),
      skipSkills: true,
      credsPassphrase,
      webSearchApiKey,
      slackBotToken,
      slackAppToken,
    };
  } catch {
    return null;
  }
}
