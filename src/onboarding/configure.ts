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
  LLM_PROVIDERS,
  LLM_PROVIDER_DISPLAY_NAMES,
  LLM_PROVIDER_DESCRIPTIONS,
  DEFAULT_MODELS,
  PROVIDER_CHOICES,
  ASCII_WELCOME,
  RECONFIGURE_HEADER,
} from './prompts.js';
import type { ProfileName, AgentType, AuthMethod, LLMProviderChoice } from './prompts.js';
import { runOnboarding, loadExistingConfig } from './wizard.js';
import type { OnboardingAnswers } from './wizard.js';

export interface InquirerDefaults {
  profile?: ProfileName;
  agent?: AgentType;
  authMethod?: AuthMethod;
  model?: string;
  llmProvider?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  oauthToken?: string;
  oauthTokenMasked?: string;
  channels?: string[];

  webSearchApiKey?: string;
  webSearchApiKeyMasked?: string;
  slackBotToken?: string;
  slackBotTokenMasked?: string;
  slackAppToken?: string;
  slackAppTokenMasked?: string;
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
    return { profile: undefined, agent: undefined, authMethod: undefined, model: undefined, llmProvider: undefined, apiKey: undefined, apiKeyMasked: undefined, channels: undefined };
  }

  return {
    profile: existing.profile,
    agent: existing.agent,
    authMethod: existing.authMethod,
    model: existing.model,
    llmProvider: existing.llmProvider,
    apiKey: existing.apiKey,
    apiKeyMasked: maskKey(existing.apiKey),
    oauthToken: existing.oauthToken,
    oauthTokenMasked: maskKey(existing.oauthToken),
    channels: existing.channels,

    webSearchApiKey: existing.webSearchApiKey,
    webSearchApiKeyMasked: maskKey(existing.webSearchApiKey),
    slackBotToken: existing.slackBotToken,
    slackBotTokenMasked: maskKey(existing.slackBotToken),
    slackAppToken: existing.slackAppToken,
    slackAppTokenMasked: maskKey(existing.slackAppToken),
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

  // 2. Auth & model — different flow depending on agent type
  let authMethod: AuthMethod = 'api-key';
  let apiKey = '';
  let oauthToken: string | undefined;
  let oauthRefreshToken: string | undefined;
  let oauthExpiresAt: number | undefined;
  let model: string | undefined;
  let llmProvider: string | undefined;

  if (agent === 'claude-code') {
    // ── Claude Code: auth method → api-key or OAuth ──
    authMethod = await select({
      message: 'Authentication method',
      choices: AUTH_METHODS.map((method) => ({
        name: `${AUTH_METHOD_DISPLAY_NAMES[method]}  —  ${AUTH_METHOD_DESCRIPTIONS[method]}`,
        value: method,
      })),
      default: defaults.authMethod ?? 'api-key',
    }) as AuthMethod;

    if (authMethod === 'oauth') {
      let reauth = true;
      if (defaults.oauthToken) {
        reauth = await confirm({
          message: `Re-authenticate with Claude? (current token: ${defaults.oauthTokenMasked})`,
          default: true,
        });
      }

      if (reauth) {
        const { runOAuthFlow } = await import('../host/oauth.js');
        const tokens = await runOAuthFlow();
        oauthToken = tokens.access_token;
        oauthRefreshToken = tokens.refresh_token;
        oauthExpiresAt = tokens.expires_at;
      } else {
        oauthToken = defaults.oauthToken;
        oauthRefreshToken = existing?.oauthRefreshToken;
        oauthExpiresAt = existing?.oauthExpiresAt;
      }
    } else {
      // Anthropic API key (only for claude-code with api-key auth)
      const apiKeyMessage = defaults.apiKeyMasked
        ? `Anthropic API key (current: ${defaults.apiKeyMasked})`
        : 'Anthropic API key';

      const apiKeyInput = await password({
        message: apiKeyMessage,
        mask: '*',
      });

      apiKey = apiKeyInput.trim() || defaults.apiKey || '';

      if (!apiKey) {
        console.log('\nWarning: No API key provided. You can set it later in ~/.ax/.env\n');
      }
    }
  } else {
    // ── Router-based agents: LLM provider → model → provider API key ──

    // a) LLM provider selection
    llmProvider = await select({
      message: 'LLM provider',
      choices: LLM_PROVIDERS.map((p) => ({
        name: `${LLM_PROVIDER_DISPLAY_NAMES[p]}  —  ${LLM_PROVIDER_DESCRIPTIONS[p]}`,
        value: p,
      })),
      default: (defaults.llmProvider as LLMProviderChoice | undefined) ?? 'anthropic',
    }) as LLMProviderChoice;

    // b) Model name input (with sensible default per provider)
    const existingModelName = defaults.model && defaults.llmProvider === llmProvider
      ? defaults.model.split('/').slice(1).join('/')
      : undefined;

    const modelName = await input({
      message: 'Model name',
      default: existingModelName ?? DEFAULT_MODELS[llmProvider as LLMProviderChoice],
    });

    model = `${llmProvider}/${modelName}`;

    // c) Provider-specific API key
    const providerDisplayName = LLM_PROVIDER_DISPLAY_NAMES[llmProvider as LLMProviderChoice] ?? llmProvider;
    const envVarName = `${llmProvider.toUpperCase()}_API_KEY`;
    const apiKeyLabel = defaults.apiKeyMasked
      ? `${providerDisplayName} API key (current: ${defaults.apiKeyMasked})`
      : `${providerDisplayName} API key`;

    const apiKeyInput = await password({
      message: apiKeyLabel,
      mask: '*',
    });

    apiKey = apiKeyInput.trim() || defaults.apiKey || '';

    if (!apiKey) {
      console.log(`\nWarning: No API key provided. Set ${envVarName} in ~/.ax/.env later.\n`);
    }
  }

  // 2b. Web search provider (non-paranoid profiles)
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

  // 3b. Per-channel token prompts
  let slackBotToken: string | undefined = defaults.slackBotToken;
  let slackAppToken: string | undefined = defaults.slackAppToken;

  if (channels.includes('slack')) {
    const botMessage = defaults.slackBotTokenMasked
      ? `Slack Bot Token (current: ${defaults.slackBotTokenMasked})`
      : 'Slack Bot Token (xoxb-...)';

    const botInput = await password({
      message: botMessage,
      mask: '*',
    });

    if (botInput.trim()) {
      slackBotToken = botInput.trim();
    }

    if (!slackBotToken) {
      console.log('\n  Warning: No Slack Bot Token provided. Set SLACK_BOT_TOKEN in ~/.ax/.env later.\n');
    }

    const appMessage = defaults.slackAppTokenMasked
      ? `Slack App Token (current: ${defaults.slackAppTokenMasked})`
      : 'Slack App Token (xapp-...)';

    const appInput = await password({
      message: appMessage,
      mask: '*',
    });

    if (appInput.trim()) {
      slackAppToken = appInput.trim();
    }

    if (!slackAppToken) {
      console.log('\n  Warning: No Slack App Token provided. Set SLACK_APP_TOKEN in ~/.ax/.env later.\n');
    }
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
      model, llmProvider,
      oauthToken, oauthRefreshToken, oauthExpiresAt,
      channels, skipSkills, installSkills,
      webProvider, webSearchApiKey,
      slackBotToken, slackAppToken,
    },
  });

  console.log(`\n  Config written to ${outputDir}/ax.yaml`);
  console.log(`  ${authMethod === 'oauth' ? 'OAuth tokens' : 'API key'} written to ${outputDir}/.env`);

  if (!skipSkills && installSkills.length > 0) {
    console.log(`  Skill install queue: ${installSkills.join(', ')}`);
  }

  console.log('');
}
