import { resolveProviderPath, listPluginProviders } from './provider-map.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import { isTracingEnabled, getTracer } from '../utils/tracing.js';
import { TracedLLMProvider } from '../providers/llm/traced.js';
import type { PluginHost } from './plugin-host.js';

export interface LoadProvidersOptions {
  /** Optional PluginHost for loading third-party plugin providers (Phase 3). */
  pluginHost?: PluginHost;
}

export async function loadProviders(config: Config, opts?: LoadProvidersOptions): Promise<ProviderRegistry> {
  // Phase 3: If a PluginHost is provided, start it so plugin-provided
  // providers are registered in the provider map before we load them.
  if (opts?.pluginHost) {
    await opts.pluginHost.startAll();
  }

  // Load credential provider FIRST and seed process.env.
  // Other providers (e.g. Slack) read tokens from process.env at creation
  // time, so credentials must be available before they are loaded.
  const credentials = await loadProvider('credentials', config.providers.credentials, config);
  const { loadCredentials } = await import('../dotenv.js');
  await loadCredentials(credentials);

  // Load database provider SECOND — storage, audit, memory all consume it.
  let database: DatabaseProvider | undefined;
  if (config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

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

  // Load storage provider BEFORE skills — skills provider needs DocumentStore
  const storageModPath = resolveProviderPath('storage', config.providers.storage);
  const storageMod = await import(storageModPath);
  const storage = await storageMod.create(config, config.providers.storage, { database });

  // Load screener first so it can be injected into the skills provider
  const screener = config.providers.screener
    ? await loadProvider('screener', config.providers.screener, config)
    : undefined;

  // Load skills provider, passing screener and storage as options
  const skillsModulePath = resolveProviderPath('skills', config.providers.skills);
  const skillsMod = await import(skillsModulePath);
  const skills = await skillsMod.create(config, config.providers.skills, { screener, storage });

  // Load memory provider, passing LLM for extraction + summary generation + database
  const memoryModPath = resolveProviderPath('memory', config.providers.memory);
  const memoryMod = await import(memoryModPath);
  const memory = await memoryMod.create(config, config.providers.memory, { llm: tracedLlm, database });

  // Load audit provider — pass database for audit/database provider
  const auditModPath = resolveProviderPath('audit', config.providers.audit);
  const auditMod = await import(auditModPath);
  const audit = await auditMod.create(config, config.providers.audit, { database });

  // Load eventbus provider (in-process pub/sub; Phase 2 adds NATS for k8s)
  const eventbus = await loadProvider('eventbus', config.providers.eventbus, config);

  return {
    llm:         tracedLlm,
    image,
    memory,
    scanner:     await loadScanner(config, tracedLlm),
    channels,
    web:         await loadProvider('web', config.providers.web, config),
    browser:     await loadProvider('browser', config.providers.browser, config),
    credentials,
    skills,
    audit,
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    scheduler:   await loadScheduler(config, database),
    storage,
    database,
    eventbus,
    screener,
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

async function loadScanner(config: Config, llm: import('../providers/llm/types.js').LLMProvider) {
  const scannerModPath = resolveProviderPath('scanner', config.providers.scanner);
  const scannerMod = await import(scannerModPath);
  return scannerMod.create(config, config.providers.scanner, { llm });
}

async function loadScheduler(config: Config, database?: DatabaseProvider) {
  const modulePath = resolveProviderPath('scheduler', config.providers.scheduler);
  const mod = await import(modulePath);
  return mod.create(config, { database });
}
