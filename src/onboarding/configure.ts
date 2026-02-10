/**
 * Interactive configure UI using @inquirer/prompts.
 *
 * Launched by `ax configure` or auto-triggered on first run.
 * When reconfiguring, pre-fills answers from existing ax.yaml.
 */

import { select, input, checkbox, password, confirm } from '@inquirer/prompts';
import {
  PROFILE_NAMES,
  PROFILE_DISPLAY_NAMES,
  PROFILE_DESCRIPTIONS,
  PROFILE_DEFAULTS,
  AGENT_TYPES,
  AGENT_DISPLAY_NAMES,
  AGENT_DESCRIPTIONS,
  AUTH_METHODS,
  AUTH_METHOD_DISPLAY_NAMES,
  AUTH_METHOD_DESCRIPTIONS,
  PROVIDER_CHOICES,
  ASCII_WELCOME,
  RECONFIGURE_HEADER,
} from './prompts.js';
import type { ProfileName, AgentType, AuthMethod } from './prompts.js';
import { runOnboarding, loadExistingConfig } from './wizard.js';
import type { OnboardingAnswers } from './wizard.js';

export interface InquirerDefaults {
  profile?: ProfileName;
  agent?: AgentType;
  authMethod?: AuthMethod;
  apiKey?: string;
  apiKeyMasked?: string;
  oauthToken?: string;
  channels?: string[];
  credsPassphrase?: string;
  webSearchApiKey?: string;
  webSearchApiKeyMasked?: string;
}

/**
 * Build default values for inquirer prompts from existing config.
 * Returns an object with undefined values if no existing config.
 */
function maskKey(key: string | undefined): string | undefined {
  if (!key || key.length <= 8) return undefined;
  return `${key.slice(0, 3)}...${key.slice(-4)}`;
}

export function buildInquirerDefaults(existing: OnboardingAnswers | null): InquirerDefaults {
  if (!existing) {
    return { profile: undefined, agent: undefined, authMethod: undefined, apiKey: undefined, apiKeyMasked: undefined, channels: undefined };
  }

  return {
    profile: existing.profile,
    agent: existing.agent,
    authMethod: existing.authMethod,
    apiKey: existing.apiKey,
    apiKeyMasked: maskKey(existing.apiKey),
    oauthToken: existing.oauthToken,
    channels: existing.channels,
    credsPassphrase: existing.credsPassphrase,
    webSearchApiKey: existing.webSearchApiKey,
    webSearchApiKeyMasked: maskKey(existing.webSearchApiKey),
  };
}

/**
 * Run the interactive configure flow.
 *
 * @param outputDir - Directory to write config files to (defaults to axHome())
 */
export async function runConfigure(outputDir: string): Promise<void> {
  const existing = loadExistingConfig(outputDir);
  const isReconfigure = existing !== null;
  const defaults = buildInquirerDefaults(existing);

  console.log(isReconfigure ? RECONFIGURE_HEADER : ASCII_WELCOME);

  // 1. Profile selection
  const profile = await select({
    message: 'Security profile',
    choices: PROFILE_NAMES.map((name) => ({
      name: `${PROFILE_DISPLAY_NAMES[name]}  —  ${PROFILE_DESCRIPTIONS[name]}`,
      value: name,
    })),
    default: defaults.profile,
  }) as OnboardingAnswers['profile'];

  // 1b. Agent type selection
  const agent = await select({
    message: 'Agent type',
    choices: AGENT_TYPES.map((name) => ({
      name: `${AGENT_DISPLAY_NAMES[name]}  —  ${AGENT_DESCRIPTIONS[name]}`,
      value: name,
    })),
    default: defaults.agent ?? PROFILE_DEFAULTS[profile].agent,
  }) as AgentType;

  // 2. Auth method selection (OAuth only available for claude-code)
  let authMethod: AuthMethod = 'api-key';
  if (agent === 'claude-code') {
    authMethod = await select({
      message: 'Authentication method',
      choices: AUTH_METHODS.map((method) => ({
        name: `${AUTH_METHOD_DISPLAY_NAMES[method]}  —  ${AUTH_METHOD_DESCRIPTIONS[method]}`,
        value: method,
      })),
      default: defaults.authMethod ?? 'api-key',
    }) as AuthMethod;
  }

  let apiKey = '';
  let oauthToken: string | undefined;
  let oauthRefreshToken: string | undefined;
  let oauthExpiresAt: number | undefined;

  if (authMethod === 'oauth') {
    // OAuth flow — open browser for Claude Max authorization
    const { runOAuthFlow } = await import('../oauth.js');
    const tokens = await runOAuthFlow();
    oauthToken = tokens.access_token;
    oauthRefreshToken = tokens.refresh_token;
    oauthExpiresAt = tokens.expires_at;
  } else {
    // API key prompt (unchanged)
    const apiKeyMessage = defaults.apiKeyMasked
      ? `Anthropic API key (current: ${defaults.apiKeyMasked})`
      : 'Anthropic API key';

    const apiKeyInput = await password({
      message: apiKeyMessage,
      mask: '*',
    });

    // If user pressed Enter without typing, keep existing key
    apiKey = apiKeyInput.trim() || defaults.apiKey || '';

    if (!apiKey) {
      console.log('\nWarning: No API key provided. You can set it later in ~/.ax/.env\n');
    }
  }

  // 2b. Credentials passphrase (only for profiles that use encrypted credentials)
  let credsPassphrase: string | undefined = defaults.credsPassphrase;
  if (PROFILE_DEFAULTS[profile].credentials === 'encrypted' && !credsPassphrase && !process.env.AX_CREDS_PASSPHRASE) {
    let matched = false;
    while (!matched) {
      const pass1 = await password({
        message: 'Credentials passphrase',
        mask: '*',
      });
      if (!pass1.trim()) {
        console.log('  Passphrase cannot be empty. Try again.\n');
        continue;
      }
      const pass2 = await password({
        message: 'Confirm passphrase',
        mask: '*',
      });
      if (pass1 !== pass2) {
        console.log('  Passphrases do not match. Try again.\n');
        continue;
      }
      credsPassphrase = pass1;
      matched = true;
    }
  }

  // 2c. Web search provider (non-paranoid profiles)
  let webProvider: string | undefined;
  let webSearchApiKey: string | undefined = defaults.webSearchApiKey;
  if (profile !== 'paranoid') {
    webProvider = await select({
      message: 'Web search provider',
      choices: [
        { name: 'Tavily Search', value: 'tavily' },
        { name: 'None', value: 'fetch' },
      ],
      default: 'tavily',
    });

    if (webProvider === 'tavily') {
      const tavilyMessage = defaults.webSearchApiKeyMasked
        ? `Tavily API key (current: ${defaults.webSearchApiKeyMasked})`
        : 'Tavily API key';

      const tavilyInput = await password({
        message: tavilyMessage,
        mask: '*',
      });

      // If user typed something, use it; otherwise keep existing
      if (tavilyInput.trim()) {
        webSearchApiKey = tavilyInput.trim();
      }

      if (!webSearchApiKey) {
        console.log('\n  Warning: No Tavily API key provided. Set TAVILY_API_KEY in ~/.ax/.env later.\n');
      }
    }
  }

  // 3. Channel selection (optional — default CLI-only)
  let channels: string[] = [];
  const hasExistingChannels = defaults.channels && defaults.channels.length > 0;
  const wantChannels = await confirm({
    message: 'Configure communication channels (Slack, Discord, etc.)?',
    default: hasExistingChannels ?? false,
  });

  if (wantChannels) {
    channels = await checkbox({
      message: 'Communication channels',
      choices: PROVIDER_CHOICES.channels.map((ch) => ({
        name: ch,
        value: ch,
        checked: defaults.channels ? defaults.channels.includes(ch) : false,
      })),
    });
  }

  // 4. Skill installation
  const skipSkills = !(await confirm({
    message: 'Install ClawHub skills?',
    default: false,
  }));

  let installSkills: string[] = [];
  if (!skipSkills) {
    const skillsInput = await input({
      message: 'Skill names (comma-separated)',
      default: '',
    });
    installSkills = skillsInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // 5. Generate config
  await runOnboarding({
    outputDir,
    answers: {
      profile, agent, authMethod, apiKey,
      oauthToken, oauthRefreshToken, oauthExpiresAt,
      channels, skipSkills, installSkills,
      credsPassphrase, webProvider, webSearchApiKey,
    },
  });

  console.log(`\n  Config written to ${outputDir}/ax.yaml`);
  console.log(`  ${authMethod === 'oauth' ? 'OAuth tokens' : 'API key'} written to ${outputDir}/.env`);

  if (!skipSkills && installSkills.length > 0) {
    console.log(`  Skill install queue: ${installSkills.join(', ')}`);
  }

  console.log('');
}
