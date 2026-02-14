/**
 * Profile-based provider defaults for onboarding.
 */

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPES = ['pi-agent-core', 'pi-coding-agent', 'claude-code'] as const;

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  'pi-agent-core': 'Pi Agent Core',
  'pi-coding-agent': 'Pi Coding Agent',
  'claude-code': 'Claude Code',
};

export const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  'pi-agent-core': 'Lightweight agent with basic tool use',
  'pi-coding-agent': 'Full coding agent with session management and compaction',
  'claude-code': 'Anthropic Claude Code agentic loop via SDK',
};

export interface ProfileDefaults {
  agent: AgentType;
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

const defaultSandbox = process.platform === 'darwin' ? 'seatbelt' : 'bwrap';

export const PROFILE_DEFAULTS: Record<string, ProfileDefaults> = {
  paranoid: {
    agent: 'pi-agent-core',
    llm: 'anthropic',
    memory: 'file',
    scanner: 'patterns',
    web: 'none',
    browser: 'none',
    credentials: 'env',
    skills: 'readonly',
    audit: 'file',
    sandbox: defaultSandbox,
    scheduler: 'cron',
    timeoutSec: 60,
    memoryMb: 256,
  },
  balanced: {
    agent: 'pi-agent-core',
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'none',
    credentials: 'env',
    skills: 'git',
    audit: 'sqlite',
    sandbox: defaultSandbox,
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 120,
    memoryMb: 512,
  },
  yolo: {
    agent: 'pi-agent-core',
    llm: 'anthropic',
    memory: 'sqlite',
    scanner: 'patterns',
    web: 'fetch',
    browser: 'container',
    credentials: 'encrypted',
    skills: 'git',
    audit: 'sqlite',
    sandbox: defaultSandbox,
    scheduler: 'full',
    skillScreener: 'static',
    timeoutSec: 300,
    memoryMb: 1024,
  },
};

export const PROFILE_NAMES = ['paranoid', 'balanced', 'yolo'] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/** User-facing display names for each profile. Change these to rename profiles in the UI. */
export const PROFILE_DISPLAY_NAMES: Record<ProfileName, string> = {
  paranoid: 'Paranoid',
  balanced: 'Balanced',
  yolo: 'YOLO',
};

export const PROFILE_DESCRIPTIONS: Record<ProfileName, string> = {
  paranoid: 'Maximum security, minimal features — no web, no browser, read-only skills',
  balanced: 'Balanced security and features — web fetch, git skills, SQLite storage (recommended)',
  yolo: 'Maximum features — browser automation, encrypted credentials, extended timeouts (be careful!)',
};

// ── Auth Method ──

export const AUTH_METHODS = ['api-key', 'oauth'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const AUTH_METHOD_DISPLAY_NAMES: Record<AuthMethod, string> = {
  'api-key': 'API Key',
  'oauth': 'Claude Max (OAuth)',
};

export const AUTH_METHOD_DESCRIPTIONS: Record<AuthMethod, string> = {
  'api-key': 'Authenticate with an Anthropic API key',
  'oauth': 'Authenticate with your Claude Max subscription via browser',
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
  sandbox: ['subprocess', 'seatbelt', 'bwrap', 'nsjail', 'docker'],
  scheduler: ['none', 'cron', 'full'],
  channels: ['slack', 'whatsapp', 'telegram', 'discord'],
} as const;

export const ASCII_WELCOME = `
   Welcome to Project AX!

   The security-first personal AI agent.
   Let's get you set up.
`;

export const RECONFIGURE_HEADER = `
   🦀  AX Configuration

   Updating your existing configuration.
   Current values are pre-selected.
`;
