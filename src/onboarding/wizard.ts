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

export interface OnboardingAnswers {
  profile: 'paranoid' | 'standard' | 'power_user';
  apiKey: string;
  channels: string[];
  skipSkills?: boolean;
  installSkills?: string[];
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
    web: defaults.web,
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

  // Build full config
  const config: Record<string, unknown> = {
    profile: answers.profile,
    providers,
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

  // Write .env with API key
  const envContent = `# AX API Keys\nANTHROPIC_API_KEY=${answers.apiKey}\n`;
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

    // Read API key from .env if it exists
    let apiKey = '';
    const envFilePath = join(dir, '.env');
    if (existsSync(envFilePath)) {
      const envContent = readFileSync(envFilePath, 'utf-8');
      const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
      if (match) apiKey = match[1].trim();
    }

    return {
      profile: parsed.profile ?? 'standard',
      apiKey,
      channels: parsed.providers?.channels ?? ['cli'],
      skipSkills: true,
    };
  } catch {
    return null;
  }
}
