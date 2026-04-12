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
  model?: string;
  llmProvider?: string;
  apiKey: string;
  oauthToken?: string;
  oauthRefreshToken?: string;
  oauthExpiresAt?: number;
  channels: string[];
  skipSkills?: boolean;
  installSkills?: string[];

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

  // Build providers object
  const providers: Record<string, unknown> = {
    memory: defaults.memory,
    security: defaults.security,
    channels: answers.channels,
    web: defaults.web,
    credentials: defaults.credentials,
    audit: defaults.audit,
    sandbox: defaults.sandbox,
    scheduler: defaults.scheduler,
  };

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
    ...(() => {
      const models: Record<string, string[]> = {};
      if (answers.model) models.default = [answers.model];
      return Object.keys(models).length > 0 ? { models } : {};
    })(),
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

  // Write credentials to credentials.yaml via the plaintext provider pattern.
  // We write the YAML file directly here (same format the plaintext provider uses)
  // rather than instantiating the provider, since the output dir may differ from AX_HOME.
  const creds: Record<string, string> = {};
  if (answers.oauthToken) {
    creds.CLAUDE_CODE_OAUTH_TOKEN = answers.oauthToken;
    if (answers.oauthRefreshToken) creds.AX_OAUTH_REFRESH_TOKEN = answers.oauthRefreshToken;
    if (answers.oauthExpiresAt) creds.AX_OAUTH_EXPIRES_AT = String(answers.oauthExpiresAt);
  } else if (answers.apiKey.trim()) {
    const apiKeyEnvVar = answers.llmProvider && answers.llmProvider !== 'anthropic'
      ? `${answers.llmProvider.toUpperCase()}_API_KEY`
      : 'ANTHROPIC_API_KEY';
    creds[apiKeyEnvVar] = answers.apiKey.trim();
  }
  if (answers.webSearchApiKey) {
    creds.TAVILY_API_KEY = answers.webSearchApiKey.trim();
  }
  if (answers.slackBotToken) {
    creds.SLACK_BOT_TOKEN = answers.slackBotToken.trim();
    if (answers.slackAppToken) {
      creds.SLACK_APP_TOKEN = answers.slackAppToken.trim();
    }
  }
  if (Object.keys(creds).length > 0) {
    const credsYaml = yamlStringify(creds, { indent: 2, lineWidth: 120 });
    writeFileSync(join(outputDir, 'credentials.yaml'), credsYaml, 'utf-8');
  }

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

    // Derive LLM provider from compound model ID (e.g. "openrouter/gpt-4.1" → "openrouter")
    const defaultModels: string[] | undefined = parsed.models?.default;
    const model: string | undefined = defaultModels?.[0];
    const llmProvider: string | undefined = model ? model.split('/')[0] : undefined;


    // Read secrets from credentials.yaml (preferred) or .env (backward compat)
    let apiKey = '';
    let webSearchApiKey: string | undefined;
    let oauthToken: string | undefined;
    let oauthRefreshToken: string | undefined;
    let oauthExpiresAt: number | undefined;
    let authMethod: 'api-key' | 'oauth' | undefined;
    let slackBotToken: string | undefined;
    let slackAppToken: string | undefined;

    const credsYamlPath = join(dir, 'credentials.yaml');
    const envFilePath = join(dir, '.env');

    // Helper to read a value from a credentials store
    const readCred = (store: Record<string, string>, key: string): string | undefined => {
      const val = store[key];
      return val !== undefined ? String(val) : undefined;
    };

    // Try credentials.yaml first, then fall back to .env for backward compat
    let creds: Record<string, string> = {};
    if (existsSync(credsYamlPath)) {
      try {
        const raw = readFileSync(credsYamlPath, 'utf-8');
        const parsed = parseYaml(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          creds = parsed as Record<string, string>;
        }
      } catch { /* ignore parse errors */ }
    }

    if (Object.keys(creds).length > 0) {
      // Read from credentials.yaml
      if (llmProvider && llmProvider !== 'anthropic') {
        const providerKeyName = `${llmProvider.toUpperCase()}_API_KEY`;
        apiKey = readCred(creds, providerKeyName) ?? '';
      }
      if (!apiKey) {
        apiKey = readCred(creds, 'ANTHROPIC_API_KEY') ?? '';
      }
      webSearchApiKey = readCred(creds, 'TAVILY_API_KEY');
      oauthToken = readCred(creds, 'CLAUDE_CODE_OAUTH_TOKEN');
      oauthRefreshToken = readCred(creds, 'AX_OAUTH_REFRESH_TOKEN');
      const expiresStr = readCred(creds, 'AX_OAUTH_EXPIRES_AT');
      if (expiresStr) oauthExpiresAt = parseInt(expiresStr, 10);
      authMethod = oauthToken ? 'oauth' : 'api-key';
      slackBotToken = readCred(creds, 'SLACK_BOT_TOKEN');
      slackAppToken = readCred(creds, 'SLACK_APP_TOKEN');
    } else if (existsSync(envFilePath)) {
      // Backward compat: read from .env
      const envContent = readFileSync(envFilePath, 'utf-8');
      if (llmProvider && llmProvider !== 'anthropic') {
        const providerKeyName = `${llmProvider.toUpperCase()}_API_KEY`;
        const providerKeyMatch = envContent.match(new RegExp(`^${providerKeyName}=(.+)$`, 'm'));
        if (providerKeyMatch) apiKey = providerKeyMatch[1].trim();
      }
      if (!apiKey) {
        const apiKeyMatch = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
        if (apiKeyMatch) apiKey = apiKeyMatch[1].trim();
      }
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
      model,
      llmProvider,
      apiKey,
      oauthToken,
      oauthRefreshToken,
      oauthExpiresAt,
      channels: (parsed.providers?.channels ?? []).filter((c: string) => c !== 'cli'),
      skipSkills: true,
      webSearchApiKey,
      slackBotToken,
      slackAppToken,
    };
  } catch {
    return null;
  }
}
