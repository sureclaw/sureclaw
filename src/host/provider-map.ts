/**
 * Static allowlist of all valid provider modules.
 *
 * SECURITY (SC-SEC-002): This is the ONLY place that maps provider names to
 * module paths. Adding a new provider requires adding a line here. No dynamic
 * path construction from config values is permitted anywhere in the codebase.
 *
 * The keys are the (kind, name) pairs from ax.yaml.
 * The values are either:
 *   - Relative paths (current): '../providers/llm/anthropic.js'
 *   - Package names (Phase 2):  '@ax/provider-llm-anthropic'
 *
 * resolveProviderPath() handles both transparently.
 */

const _PROVIDER_MAP = {
  llm: {
    anthropic:  '../providers/llm/anthropic.js',
    openai:     '../providers/llm/openai.js',
    openrouter: '../providers/llm/openai.js',
    groq:       '../providers/llm/openai.js',
    router:     '../providers/llm/router.js',
    mock:       '../providers/llm/mock.js',
  },
  image: {
    openai:     '../providers/image/openai-images.js',
    openrouter: '../providers/image/openrouter.js',
    groq:       '../providers/image/openai-images.js',
    gemini:     '../providers/image/gemini.js',
    router:     '../providers/image/router.js',
    mock:       '../providers/image/mock.js',
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
    plaintext: '../providers/credentials/plaintext.js',
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
  screener: {
    static: '../providers/screener/static.js',
    none:   '../providers/screener/none.js',
  },
} as const;

// Re-export with the same name and looser type for backwards compatibility.
// Callers that use PROVIDER_MAP directly still work; callers that want
// compile-time checked names can use the typed unions below.
export const PROVIDER_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = _PROVIDER_MAP;

// =====================================================
// Typed unions derived from the allowlist
// =====================================================
// These give autocomplete and compile-time errors for invalid provider names.

type ProviderMapType = typeof _PROVIDER_MAP;

/** All valid provider kinds (llm, memory, scanner, ...). */
export type ProviderKind = keyof ProviderMapType;

/** Valid names for each provider kind. */
export type LLMProviderName        = keyof ProviderMapType['llm'];
export type ImageProviderName      = keyof ProviderMapType['image'];
export type MemoryProviderName     = keyof ProviderMapType['memory'];
export type ScannerProviderName    = keyof ProviderMapType['scanner'];
export type ChannelProviderName    = keyof ProviderMapType['channel'];
export type WebProviderName        = keyof ProviderMapType['web'];
export type BrowserProviderName    = keyof ProviderMapType['browser'];
export type CredentialProviderName = keyof ProviderMapType['credentials'];
export type SkillsProviderName     = keyof ProviderMapType['skills'];
export type AuditProviderName      = keyof ProviderMapType['audit'];
export type SandboxProviderName    = keyof ProviderMapType['sandbox'];
export type SchedulerProviderName  = keyof ProviderMapType['scheduler'];
export type ScreenerProviderName   = keyof ProviderMapType['screener'];

/** Union of all provider names for a given kind. */
export type ProviderNameFor<K extends ProviderKind> = keyof ProviderMapType[K];

/**
 * SECURITY: Post-resolution URL protocol guard.
 *
 * Every resolved provider path MUST be a file:// URL. This prevents a
 * compromised or malformed provider map entry from loading code via
 * data:, http:, node:, or other URL schemes that bypass the filesystem.
 *
 * Defense-in-depth: the allowlist already constrains inputs, but this
 * catches any future regression where a non-file URL leaks through.
 */
function assertFileUrl(url: string, kind: string, name: string): void {
  if (!url.startsWith('file://')) {
    throw new Error(
      `SC-SEC-002 violation: provider ${kind}/${name} resolved to non-file URL ` +
      `(got ${url.split(':')[0]}:// scheme). Only file:// URLs are permitted.`
    );
  }
}

/**
 * Returns an absolute file URL for a given provider kind and name.
 * Resolves the relative path from the PROVIDER_MAP against this module's
 * location so the result can be used from any import() call site.
 *
 * Supports two path formats:
 *   - Relative paths: '../providers/llm/anthropic.js' → file:// URL
 *   - Package names:  '@ax/provider-llm-anthropic'    → returned as-is for import()
 *
 * Throws if the (kind, name) combination is not in the allowlist.
 */
export function resolveProviderPath(kind: string, name: string): string {
  // First check the built-in allowlist
  const kindMap = PROVIDER_MAP[kind];
  if (!kindMap) {
    // Also check the plugin registry for Phase 3 plugin-hosted providers
    const pluginPath = _pluginProviderMap.get(`${kind}/${name}`);
    if (pluginPath) return pluginPath;

    throw new Error(
      `Unknown provider kind: "${kind}". ` +
      `Valid kinds: ${Object.keys(PROVIDER_MAP).join(', ')}`
    );
  }

  const modulePath = kindMap[name];
  if (!modulePath) {
    // Also check the plugin registry for Phase 3 plugin-hosted providers
    const pluginPath = _pluginProviderMap.get(`${kind}/${name}`);
    if (pluginPath) return pluginPath;

    throw new Error(
      `Unknown ${kind} provider: "${name}". ` +
      `Valid ${kind} providers: ${Object.keys(kindMap).join(', ')}`
    );
  }

  // Package names (starting with @ or not starting with . or /)
  // are resolved via import.meta.resolve() to pin them to THIS module's
  // node_modules — not the CWD's. Without this, an attacker who controls
  // the working directory could plant a malicious node_modules/@ax/ that
  // shadows the real package. import.meta.resolve() behaves like new URL()
  // for relative paths: it resolves from this file's location, not CWD.
  if (modulePath.startsWith('@') || (!modulePath.startsWith('.') && !modulePath.startsWith('/'))) {
    const resolved = import.meta.resolve(modulePath);
    assertFileUrl(resolved, kind, name);
    return resolved;
  }

  // Resolve the relative path against this module's location to produce
  // an absolute file:// URL usable from any import() call site.
  const resolved = new URL(modulePath, import.meta.url).href;
  assertFileUrl(resolved, kind, name);
  return resolved;
}

// =====================================================
// Plugin provider registration (Phase 3)
// =====================================================

/**
 * Runtime-registered plugin providers. Entries are added by the PluginHost
 * when loading vetted third-party plugins from plugins.lock.
 *
 * SECURITY: This map is populated ONLY by the trusted PluginHost during
 * startup — never from user input or config values directly.
 * Each entry is a (kind/name) → module-path mapping verified against
 * the plugin's integrity hash.
 *
 * The map key format is "kind/name" (e.g., "memory/postgres").
 */
const _pluginProviderMap = new Map<string, string>();

/**
 * Register a plugin-provided provider in the runtime allowlist.
 * Called by PluginHost after verifying the plugin manifest and integrity.
 *
 * SECURITY: Only the PluginHost should call this. The caller is responsible
 * for verifying the plugin's integrity hash before registration.
 */
export function registerPluginProvider(kind: string, name: string, modulePath: string): void {
  const key = `${kind}/${name}`;

  // Prevent overwriting built-in providers
  if (PROVIDER_MAP[kind]?.[name]) {
    throw new Error(
      `Cannot register plugin provider "${key}": conflicts with built-in provider`
    );
  }

  _pluginProviderMap.set(key, modulePath);
}

/**
 * Remove a plugin-provided provider from the runtime allowlist.
 * Called during plugin removal.
 */
export function unregisterPluginProvider(kind: string, name: string): boolean {
  return _pluginProviderMap.delete(`${kind}/${name}`);
}

/** Returns all registered plugin providers (for diagnostics). */
export function listPluginProviders(): Array<{ kind: string; name: string; modulePath: string }> {
  return [..._pluginProviderMap.entries()].map(([key, modulePath]) => {
    const [kind, name] = key.split('/');
    return { kind, name, modulePath };
  });
}

/** Clear all plugin providers (for testing). */
export function clearPluginProviders(): void {
  _pluginProviderMap.clear();
}
