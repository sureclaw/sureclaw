/**
 * Profile-based provider defaults for onboarding.
 */

export type AgentType = (typeof AGENT_TYPES)[number];

export const AGENT_TYPES = ['pi-coding-agent', 'claude-code'] as const;

export const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  'pi-coding-agent': 'Pi Coding Agent',
  'claude-code': 'Claude Code',
};

export const AGENT_DESCRIPTIONS: Record<AgentType, string> = {
  'pi-coding-agent': 'Full coding agent with session management, tool use, and compaction',
  'claude-code': 'Anthropic Claude Code agentic loop via SDK',
};

export interface ProfileDefaults {
  agent: AgentType;
  memory: string;
  security: string;
  web: { extract: string; search: string };
  credentials: string;
  audit: string;
  sandbox: string;
  scheduler: string;
  timeoutSec: number;
  memoryMb: number;
}

const defaultSandbox = process.platform === 'darwin' ? 'apple' : 'docker';

export const PROFILE_DEFAULTS: Record<string, ProfileDefaults> = {
  paranoid: {
    agent: 'pi-coding-agent',
    memory: 'cortex',
    security: 'patterns',
    web: { extract: 'none', search: 'none' },
    credentials: 'keychain',

    audit: 'database',
    sandbox: defaultSandbox,
    scheduler: 'plainjob',
    timeoutSec: 60,
    memoryMb: 256,
  },
  balanced: {
    agent: 'pi-coding-agent',
    memory: 'cortex',
    security: 'patterns',
    web: { extract: 'none', search: 'none' },
    credentials: 'keychain',

    audit: 'database',
    sandbox: defaultSandbox,
    scheduler: 'plainjob',
    timeoutSec: 120,
    memoryMb: 512,
  },
  yolo: {
    agent: 'pi-coding-agent',
    memory: 'cortex',
    security: 'patterns',
    web: { extract: 'none', search: 'none' },
    credentials: 'keychain',

    audit: 'database',
    sandbox: defaultSandbox,
    scheduler: 'plainjob',
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
  paranoid: 'Maximum security, minimal features — no web, database skills',
  balanced: 'Balanced security and features — web fetch, database skills, SQLite storage (recommended)',
  yolo: 'Maximum features — extended timeouts (be careful!)',
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

// ── LLM Provider (for router-based agents) ──

export const LLM_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'groq', 'deepinfra'] as const;
export type LLMProviderChoice = (typeof LLM_PROVIDERS)[number];

export const LLM_PROVIDER_DISPLAY_NAMES: Record<LLMProviderChoice, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepinfra: 'DeepInfra',
};

export const LLM_PROVIDER_DESCRIPTIONS: Record<LLMProviderChoice, string> = {
  anthropic: 'Claude models (claude-sonnet-4, claude-opus-4, etc.)',
  openai: 'GPT models via OpenAI API',
  openrouter: 'Multi-provider access via OpenRouter',
  groq: 'Fast inference via Groq',
  deepinfra: 'Serverless inference via DeepInfra',
};

export const DEFAULT_MODELS: Record<LLMProviderChoice, string> = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4.1',
  openrouter: 'anthropic/claude-sonnet-4',
  groq: 'llama-3.3-70b-versatile',
  deepinfra: 'meta-llama/Meta-Llama-3.1-70B-Instruct',
};

/** Available provider choices per category, derived from the provider map. */
export const PROVIDER_CHOICES = {
  memory: ['cortex'],
  scanner: ['patterns'],
  web_extract: ['none', 'tavily'],
  web_search: ['none', 'tavily', 'brave'],
  credentials: ['keychain', 'plaintext'],
  audit: ['database'],
  sandbox: ['docker', 'apple', 'k8s'],
  scheduler: ['none', 'plainjob'],
  channels: ['slack'],
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
