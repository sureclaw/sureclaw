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
    anthropic: './providers/llm/anthropic.js',
    openai:    './providers/llm/openai.js',
    multi:     './providers/llm/multi.js',
    mock:      './providers/llm/mock.js',
  },
  memory: {
    file:   './providers/memory/file.js',
    sqlite: './providers/memory/sqlite.js',
    memu:   './providers/memory/memu.js',
  },
  scanner: {
    basic:     './providers/scanner/basic.js',
    patterns:  './providers/scanner/patterns.js',
    promptfoo: './providers/scanner/promptfoo.js',
  },
  channel: {
    cli:       './providers/channel/cli.js',
    slack:     './providers/channel/slack.js',
    whatsapp:  './providers/channel/whatsapp.js',
    telegram:  './providers/channel/telegram.js',
    discord:   './providers/channel/discord.js',
  },
  web: {
    none:   './providers/web/none.js',
    fetch:  './providers/web/fetch.js',
    brave:  './providers/web/brave.js',
    tavily: './providers/web/tavily.js',
  },
  browser: {
    none:      './providers/browser/none.js',
    container: './providers/browser/container.js',
  },
  credentials: {
    env:       './providers/credentials/env.js',
    encrypted: './providers/credentials/encrypted.js',
    keychain:  './providers/credentials/keychain.js',
  },
  skills: {
    readonly: './providers/skills/readonly.js',
    git:      './providers/skills/git.js',
  },
  audit: {
    file:   './providers/audit/file.js',
    sqlite: './providers/audit/sqlite.js',
  },
  sandbox: {
    subprocess: './providers/sandbox/subprocess.js',
    seatbelt:   './providers/sandbox/seatbelt.js',
    nsjail:     './providers/sandbox/nsjail.js',
    docker:     './providers/sandbox/docker.js',
  },
  scheduler: {
    none: './providers/scheduler/none.js',
    cron: './providers/scheduler/cron.js',
    full: './providers/scheduler/full.js',
  },
} as const;

/**
 * Returns the module path for a given provider kind and name.
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

  const modulePath = kindMap[name];
  if (!modulePath) {
    throw new Error(
      `Unknown ${kind} provider: "${name}". ` +
      `Valid ${kind} providers: ${Object.keys(kindMap).join(', ')}`
    );
  }

  return modulePath;
}
