/**
 * Interactive configure UI using @inquirer/prompts.
 *
 * Launched by `ax configure` or auto-triggered on first run.
 * When reconfiguring, pre-fills answers from existing ax.yaml.
 */

import { select, input, checkbox, password, confirm } from '@inquirer/prompts';
import {
  PROFILE_NAMES,
  PROFILE_DESCRIPTIONS,
  PROVIDER_CHOICES,
  ASCII_CRAB,
  RECONFIGURE_HEADER,
} from './prompts.js';
import { runOnboarding, loadExistingConfig } from './wizard.js';
import type { OnboardingAnswers } from './wizard.js';

export interface InquirerDefaults {
  profile?: string;
  apiKey?: string;
  apiKeyMasked?: string;
  channels?: string[];
}

/**
 * Build default values for inquirer prompts from existing config.
 * Returns an object with undefined values if no existing config.
 */
export function buildInquirerDefaults(existing: OnboardingAnswers | null): InquirerDefaults {
  if (!existing) {
    return { profile: undefined, apiKey: undefined, apiKeyMasked: undefined, channels: undefined };
  }

  // Mask API key for display: show first 3 chars + last 4 chars
  let apiKeyMasked: string | undefined;
  if (existing.apiKey && existing.apiKey.length > 8) {
    apiKeyMasked = `${existing.apiKey.slice(0, 3)}...${existing.apiKey.slice(-4)}`;
  }

  return {
    profile: existing.profile,
    apiKey: existing.apiKey,
    apiKeyMasked,
    channels: existing.channels,
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

  console.log(isReconfigure ? RECONFIGURE_HEADER : ASCII_CRAB);

  // 1. Profile selection
  const profile = await select({
    message: 'Security profile',
    choices: PROFILE_NAMES.map((name) => ({
      name: `${name}  —  ${PROFILE_DESCRIPTIONS[name]}`,
      value: name,
    })),
    default: defaults.profile,
  }) as OnboardingAnswers['profile'];

  // 2. API key
  const apiKeyMessage = defaults.apiKeyMasked
    ? `Anthropic API key (current: ${defaults.apiKeyMasked})`
    : 'Anthropic API key';

  const apiKeyInput = await password({
    message: apiKeyMessage,
    mask: '*',
  });

  // If user pressed Enter without typing, keep existing key
  const apiKey = apiKeyInput.trim() || defaults.apiKey || '';

  if (!apiKey) {
    console.log('\nWarning: No API key provided. You can set it later in ~/.ax/.env\n');
  }

  // 3. Channel selection
  const channels = await checkbox({
    message: 'Communication channels',
    choices: PROVIDER_CHOICES.channels.map((ch) => ({
      name: ch,
      value: ch,
      checked: defaults.channels ? defaults.channels.includes(ch) : ch === 'cli',
    })),
  });

  // Ensure at least 'cli' is selected
  if (channels.length === 0) {
    channels.push('cli');
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
    answers: { profile, apiKey, channels, skipSkills, installSkills },
  });

  console.log(`\n  Config written to ${outputDir}/ax.yaml`);
  console.log(`  API key written to ${outputDir}/.env`);

  if (!skipSkills && installSkills.length > 0) {
    console.log(`  Skill install queue: ${installSkills.join(', ')}`);
  }

  console.log('');
}
