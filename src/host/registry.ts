import { resolveProviderPath } from './provider-map.js';
import type { Config, ProviderRegistry } from '../types.js';
import { isTracingEnabled, getTracer } from '../utils/tracing.js';
import { TracedLLMProvider } from '../providers/llm/traced.js';

export async function loadProviders(config: Config): Promise<ProviderRegistry> {
  // Filter out 'cli' — the CLI channel was replaced by the ax chat/send clients.
  // Old configs may still list it; silently skip for backward compatibility.
  const channelNames = config.providers.channels.filter(name => (name as string) !== 'cli');
  const channels = await Promise.all(
    channelNames.map(name => loadProvider('channel', name, config))
  );

  // For claude-code agents, LLM calls go through the credential-injecting proxy,
  // not through IPC. Load 'anthropic' as a stub so the server can report a model
  // name. For all other agents, always use the LLM router — it parses compound
  // provider/model IDs from config.models.
  const llmProviderName = config.agent === 'claude-code'
    ? 'anthropic'
    : 'router';

  const llm = await loadProvider('llm', llmProviderName, config);
  const tracedLlm = isTracingEnabled()
    ? new TracedLLMProvider(llm, getTracer())
    : llm;

  // Load image router only when models.image is configured.
  const image = config.models?.image?.length
    ? await loadProvider('image', 'router', config)
    : undefined;

  // Load screener first so it can be injected into the skills provider
  const skillScreener = config.providers.skillScreener
    ? await loadProvider('screener', config.providers.skillScreener, config)
    : undefined;

  // Load skills provider, passing screener as an option
  const skillsModulePath = resolveProviderPath('skills', config.providers.skills);
  const skillsMod = await import(skillsModulePath);
  const skills = await skillsMod.create(config, config.providers.skills, { screener: skillScreener });

  return {
    llm:         tracedLlm,
    image,
    memory:      await loadProvider('memory', config.providers.memory, config),
    scanner:     await loadProvider('scanner', config.providers.scanner, config),
    channels,
    web:         await loadProvider('web', config.providers.web, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials: await loadProvider('credentials', config.providers.credentials, config),
    skills,
    audit:       await loadProvider('audit', config.providers.audit, config),
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadProvider('scheduler', config.providers.scheduler, config),
    skillScreener,
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
