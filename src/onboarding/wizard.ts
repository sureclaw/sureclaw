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
import type { ProfileName } from './prompts.js';

export interface OnboardingAnswers {
  profile: ProfileName;
  llmProvider?: string;
  model?: string;
  apiKey: string;
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

  // Build minimal config — code defaults in config.ts handle everything else
  const config: Record<string, unknown> = {
    profile: answers.profile,
    ...(() => {
      const models: Record<string, string[]> = {};
      if (answers.model) models.default = [answers.model];
      return Object.keys(models).length > 0 ? { models } : {};
    })(),
    sandbox: {
      timeout_sec: defaults.timeoutSec,
      memory_mb: defaults.memoryMb,
    },
  };

  // Write ax.yaml
  const yamlContent = yamlStringify(config, { indent: 2, lineWidth: 120 });
  writeFileSync(join(outputDir, 'ax.yaml'), yamlContent, 'utf-8');

  // Write credentials to credentials.yaml
  const creds: Record<string, string> = {};
  if (answers.apiKey.trim()) {
    const apiKeyEnvVar = answers.llmProvider && answers.llmProvider !== 'anthropic'
      ? `${answers.llmProvider.toUpperCase()}_API_KEY`
      : 'ANTHROPIC_API_KEY';
    creds[apiKeyEnvVar] = answers.apiKey.trim();
  }
  if (Object.keys(creds).length > 0) {
    const credsYaml = yamlStringify(creds, { indent: 2, lineWidth: 120 });
    writeFileSync(join(outputDir, 'credentials.yaml'), credsYaml, 'utf-8');
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

    // Read API key from credentials.yaml
    let apiKey = '';
    const credsYamlPath = join(dir, 'credentials.yaml');

    if (existsSync(credsYamlPath)) {
      try {
        const credsRaw = readFileSync(credsYamlPath, 'utf-8');
        const creds = parseYaml(credsRaw);
        if (creds && typeof creds === 'object' && !Array.isArray(creds)) {
          const store = creds as Record<string, string>;
          if (llmProvider && llmProvider !== 'anthropic') {
            const providerKeyName = `${llmProvider.toUpperCase()}_API_KEY`;
            apiKey = store[providerKeyName] ? String(store[providerKeyName]) : '';
          }
          if (!apiKey) {
            apiKey = store.ANTHROPIC_API_KEY ? String(store.ANTHROPIC_API_KEY) : '';
          }
        }
      } catch { /* ignore parse errors */ }
    }

    return {
      profile: parsed.profile ?? 'balanced',
      model,
      llmProvider,
      apiKey,
    };
  } catch {
    return null;
  }
}
