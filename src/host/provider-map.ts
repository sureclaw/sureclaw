/**
 * Static allowlist of all valid provider modules.
 *
 * SECURITY (SC-SEC-002): This is the ONLY place that maps provider names to
 * module paths. Adding a new provider requires adding a line here. No dynamic
 * path construction from config values is permitted anywhere in the codebase.
 *
 * The keys are the (kind, name) pairs from ax.yaml.
 * The values are the import paths relative to this file's location.
 */

export const PROVIDER_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  llm: {
    anthropic:  '../providers/llm/anthropic.js',
    openai:     '../providers/llm/openai.js',
    openrouter: '../providers/llm/openai.js',
    groq:       '../providers/llm/openai.js',
    router:     '../providers/llm/router.js',
    mock:       '../providers/llm/mock.js',
  },
  memory: {
    file:   '../providers/memory/file.js',
    sqlite: '../providers/memory/sqlite.js',
    memu:   '../providers/memory/memu.js',
  },
  scanner: {
    basic:     '../providers/scanner/basic.js',
    patterns:  '../providers/scanner/patterns.js',
    promptfoo: '../providers/scanner/promptfoo.js',
  },
  channel: {
    slack:     '../providers/channel/slack.js',
    whatsapp:  '../providers/channel/whatsapp.js',
    telegram:  '../providers/channel/telegram.js',
    discord:   '../providers/channel/discord.js',
  },
  web: {
    none:   '../providers/web/none.js',
    fetch:  '../providers/web/fetch.js',
    tavily: '../providers/web/tavily.js',
  },
  browser: {
    none:      '../providers/browser/none.js',
    container: '../providers/browser/container.js',
  },
  credentials: {
    env:       '../providers/credentials/env.js',
    encrypted: '../providers/credentials/encrypted.js',
    keychain:  '../providers/credentials/keychain.js',
  },
  skills: {
    readonly: '../providers/skills/readonly.js',
    git:      '../providers/skills/git.js',
  },
  audit: {
    file:   '../providers/audit/file.js',
    sqlite: '../providers/audit/sqlite.js',
  },
  sandbox: {
    subprocess: '../providers/sandbox/subprocess.js',
    seatbelt:   '../providers/sandbox/seatbelt.js',
    nsjail:     '../providers/sandbox/nsjail.js',
    bwrap:      '../providers/sandbox/bwrap.js',
    docker:     '../providers/sandbox/docker.js',
  },
  scheduler: {
    none: '../providers/scheduler/none.js',
    cron: '../providers/scheduler/cron.js',
    full: '../providers/scheduler/full.js',
  },
} as const;

/**
 * Returns an absolute file URL for a given provider kind and name.
 * Resolves the relative path from the PROVIDER_MAP against this module's
 * location so the result can be used from any file in the project.
 * Throws if the combination is not in the allowlist.
 */
export function resolveProviderPath(kind: string, name: string): string {
  const kindMap = PROVIDER_MAP[kind];
  if (!kindMap) {
    throw new Error(
      `Unknown provider kind: "${kind}". ` +
      `Valid kinds: ${Object.keys(PROVIDER_MAP).join(', ')}`
    );
  }

  const relativePath = kindMap[name];
  if (!relativePath) {
    throw new Error(
      `Unknown ${kind} provider: "${name}". ` +
      `Valid ${kind} providers: ${Object.keys(kindMap).join(', ')}`
    );
  }

  // Resolve the relative path against this module's location to produce
  // an absolute file:// URL usable from any import() call site.
  return new URL(relativePath, import.meta.url).href;
}
