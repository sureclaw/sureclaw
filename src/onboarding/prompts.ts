/**
 * Profile-based provider defaults for onboarding.
 */

export const PROFILE_NAMES = ['paranoid', 'balanced', 'yolo'] as const;

export type ProfileName = (typeof PROFILE_NAMES)[number];

/** User-facing display names for each profile. Change these to rename profiles in the UI. */
export const PROFILE_DISPLAY_NAMES: Record<ProfileName, string> = {
  paranoid: 'Paranoid',
  balanced: 'Balanced',
  yolo: 'YOLO',
};

export const PROFILE_DESCRIPTIONS: Record<ProfileName, string> = {
  paranoid: 'Maximum security, minimal features — no web, short timeouts',
  balanced: 'Balanced security and features (recommended)',
  yolo: 'Maximum features — extended timeouts (be careful!)',
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

export const ASCII_WELCOME = `
   Welcome to Project AX!

   The security-first personal AI agent.
   Let's get you set up.
`;

export const RECONFIGURE_HEADER = `
   AX Configuration

   Updating your existing configuration.
   Current values are pre-selected.
`;
