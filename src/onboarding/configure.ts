/**
 * Interactive configure UI using @inquirer/prompts.
 *
 * Launched by `ax configure` or auto-triggered on first run.
 * When reconfiguring, pre-fills answers from existing ax.yaml.
 *
 * Three questions: profile → LLM provider → API key.
 */

import { select, input, password } from '@inquirer/prompts';
import {
  PROFILE_NAMES,
  PROFILE_DISPLAY_NAMES,
  PROFILE_DESCRIPTIONS,
  LLM_PROVIDERS,
  LLM_PROVIDER_DISPLAY_NAMES,
  LLM_PROVIDER_DESCRIPTIONS,
  DEFAULT_MODELS,
  ASCII_WELCOME,
  RECONFIGURE_HEADER,
} from './prompts.js';
import type { ProfileName, LLMProviderChoice } from './prompts.js';
import { runOnboarding, loadExistingConfig, loadExistingApiKey } from './wizard.js';
import type { OnboardingAnswers } from './wizard.js';

export interface InquirerDefaults {
  profile?: ProfileName;
  model?: string;
  llmProvider?: string;
  apiKey?: string;
  apiKeyMasked?: string;
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
    return { profile: undefined, model: undefined, llmProvider: undefined, apiKey: undefined, apiKeyMasked: undefined };
  }

  return {
    profile: existing.profile,
    model: existing.model,
    llmProvider: existing.llmProvider,
    apiKey: existing.apiKey,
    apiKeyMasked: maskKey(existing.apiKey),
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

  // Load existing API key from database for reconfigure flow
  if (isReconfigure && existing) {
    const existingKey = await loadExistingApiKey(outputDir, existing.llmProvider);
    if (existingKey) {
      defaults.apiKey = existingKey;
      defaults.apiKeyMasked = maskKey(existingKey);
    }
  }

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

  // 2. LLM provider selection
  const llmProvider = await select({
    message: 'LLM provider',
    choices: LLM_PROVIDERS.map((p) => ({
      name: `${LLM_PROVIDER_DISPLAY_NAMES[p]}  —  ${LLM_PROVIDER_DESCRIPTIONS[p]}`,
      value: p,
    })),
    default: (defaults.llmProvider as LLMProviderChoice | undefined) ?? 'anthropic',
  }) as LLMProviderChoice;

  // 3. Model name input (with sensible default per provider)
  const existingModelName = defaults.model && defaults.llmProvider === llmProvider
    ? defaults.model.split('/').slice(1).join('/')
    : undefined;

  const modelName = await input({
    message: 'Model name',
    default: existingModelName ?? DEFAULT_MODELS[llmProvider as LLMProviderChoice],
  });

  const model = `${llmProvider}/${modelName}`;

  // 4. Provider-specific API key
  const providerDisplayName = LLM_PROVIDER_DISPLAY_NAMES[llmProvider as LLMProviderChoice] ?? llmProvider;
  const envVarName = `${llmProvider.toUpperCase()}_API_KEY`;
  const apiKeyLabel = defaults.apiKeyMasked
    ? `${providerDisplayName} API key (current: ${defaults.apiKeyMasked})`
    : `${providerDisplayName} API key`;

  const apiKeyInput = await password({
    message: apiKeyLabel,
    mask: '*',
  });

  const apiKey = apiKeyInput.trim() || defaults.apiKey || '';

  if (!apiKey) {
    console.log(`\nWarning: No API key provided. Set ${envVarName} later via ax configure.\n`);
  }

  // Generate config and store credentials
  await runOnboarding({
    outputDir,
    answers: { profile, model, llmProvider, apiKey },
  });

  console.log(`\n  Config written to ${outputDir}/ax.yaml`);
  console.log(`  Credentials stored in database`);
  console.log('');
}
