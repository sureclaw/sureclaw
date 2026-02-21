import { resolveProviderPath } from './provider-map.js';
import type { Config, ProviderRegistry } from '../types.js';

export async function loadProviders(config: Config): Promise<ProviderRegistry> {
  // Filter out 'cli' — the CLI channel was replaced by the ax chat/send clients.
  // Old configs may still list it; silently skip for backward compatibility.
  const channelNames = config.providers.channels.filter(name => name !== 'cli');
  const channels = await Promise.all(
    channelNames.map(name => loadProvider('channel', name, config))
  );

  // For claude-code agents, LLM calls go through the credential-injecting proxy,
  // not through IPC. Load the config-specified provider (typically 'anthropic') as
  // a stub. For all other agents, always use the LLM router for model routing
  // and fallback — it parses compound provider/model IDs from config.model.
  const llmProviderName = config.agent === 'claude-code'
    ? config.providers.llm
    : 'router';

  return {
    llm:         await loadProvider('llm', llmProviderName, config),
    memory:      await loadProvider('memory', config.providers.memory, config),
    scanner:     await loadProvider('scanner', config.providers.scanner, config),
    channels,
    web:         await loadProvider('web', config.providers.web, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials: await loadProvider('credentials', config.providers.credentials, config),
    skills:      await loadProvider('skills', config.providers.skills, config),
    audit:       await loadProvider('audit', config.providers.audit, config),
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadProvider('scheduler', config.providers.scheduler, config),
    skillScreener: undefined, // Not yet implemented — planned for future release
  };
}

async function loadProvider(kind: string, name: string, config: Config) {
  const modulePath = resolveProviderPath(kind, name);
  const mod = await import(modulePath);

  if (typeof mod.create !== 'function') {
    throw new Error(
      `Provider ${kind}/${name} (${modulePath}) does not export a create() function`
    );
  }

  return mod.create(config, name);
}
