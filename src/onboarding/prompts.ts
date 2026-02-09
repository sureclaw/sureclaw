/**
 * Profile-based provider defaults for onboarding.
 */

export interface ProfileDefaults {
  llm: string;
  memory: string;
  scanner: string;
  web: string;
  browser: string;
  credentials: string;
  skills: string;
  audit: string;
  sandbox: string;
  scheduler: string;
  skillScreener?: string;
  timeoutSec: number;
  memoryMb: number;
}

export const PROFILE_DEFAULTS: Record<string, ProfileDefaults> = {
  paranoid: {
    llm: 'anthropic',
    memory: 'file',
    scanner: 'patterns',
    web: 'none',
    browser: 'none',
    credentials: 'env',
    skills: 'readonly',
    audit: 'file',
    sandbox: 'seatbelt',
    scheduler: 'cron',
    timeoutSec: 60,
    memoryMb: 256,
  },
  standard: {
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'none',
    credentials: 'env',
    skills: 'git',
    audit: 'sqlite',
    sandbox: 'seatbelt',
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 120,
    memoryMb: 512,
  },
  power_user: {
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'container',
    credentials: 'encrypted',
    skills: 'git',
    audit: 'sqlite',
    sandbox: 'seatbelt',
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 300,
    memoryMb: 1024,
  },
};

export const PROFILE_NAMES = ['paranoid', 'standard', 'power_user'] as const;

export const PROFILE_DESCRIPTIONS: Record<string, string> = {
  paranoid: 'Maximum security, minimal features — no web, no browser, read-only skills',
  standard: 'Balanced security and features — web fetch, git skills, SQLite storage (recommended)',
  power_user: 'Maximum features — browser automation, encrypted credentials, extended timeouts',
};

/** Available provider choices per category, derived from the provider map. */
export const PROVIDER_CHOICES = {
  llm: ['anthropic'],
  memory: ['file', 'sqlite'],
  scanner: ['basic', 'patterns'],
  web: ['none', 'fetch'],
  browser: ['none', 'container'],
  credentials: ['env', 'encrypted'],
  skills: ['readonly', 'git'],
  audit: ['file', 'sqlite'],
  sandbox: ['subprocess', 'seatbelt', 'nsjail', 'docker'],
  scheduler: ['none', 'cron', 'full'],
  channels: ['cli', 'slack', 'whatsapp', 'telegram', 'discord'],
} as const;

export const ASCII_CRAB = `
   🦀  Welcome to SureClaw!

   The security-first personal AI agent.
   Let's get you set up.
`;

export const RECONFIGURE_HEADER = `
   🦀  SureClaw Configuration

   Updating your existing configuration.
   Current values are pre-selected.
`;
