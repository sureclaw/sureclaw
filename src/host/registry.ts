import { resolveProviderPath, listPluginProviders } from './provider-map.js';
import type { Config, ProviderRegistry } from '../types.js';
import type { DatabaseProvider } from '../providers/database/types.js';
import type { AuthProvider } from '../providers/auth/types.js';
import { isTracingEnabled, getTracer } from '../utils/tracing.js';
import { TracedLLMProvider } from '../providers/llm/traced.js';
import type { PluginHost } from './plugin-host.js';

export interface LoadProvidersOptions {
  /** Optional PluginHost for loading third-party plugin providers (Phase 3). */
  pluginHost?: PluginHost;
  /** Override specific providers after loading (test/debug only). */
  providerOverrides?: Partial<ProviderRegistry>;
}

export async function loadProviders(config: Config, opts?: LoadProvidersOptions): Promise<ProviderRegistry> {
  // Phase 3: If a PluginHost is provided, start it so plugin-provided
  // providers are registered in the provider map before we load them.
  if (opts?.pluginHost) {
    await opts.pluginHost.startAll();
  }

  // Database must load first — credential provider depends on it.
  let database: DatabaseProvider | undefined;
  if (config.providers.database) {
    const dbModPath = resolveProviderPath('database', config.providers.database);
    const dbMod = await import(dbModPath);
    database = await dbMod.create(config);
  }

  // Load credential provider and seed process.env.
  // Other providers (e.g. Slack) read tokens from process.env at creation
  // time, so credentials must be available before they are loaded.
  const credModPath = resolveProviderPath('credentials', config.providers.credentials);
  const credMod = await import(credModPath);
  const credentials = await credMod.create(config, config.providers.credentials, { database });
  const { loadCredentials } = await import('../dotenv.js');
  await loadCredentials(credentials);

  // Load auth providers (after credentials so env vars are available)
  const authProviders: AuthProvider[] = [];
  if (config.providers.auth?.length) {
    for (const name of config.providers.auth) {
      const provider = await loadProvider('auth', name, config) as AuthProvider;
      if (provider.init) await provider.init();
      authProviders.push(provider);
    }
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

  // Load storage provider BEFORE skills — skills provider needs DocumentStore
  const storageModPath = resolveProviderPath('storage', config.providers.storage);
  const storageMod = await import(storageModPath);
  const storage = await storageMod.create(config, config.providers.storage, { database });

  // Load eventbus provider BEFORE memory and scheduler — both consume it.
  const eventbus = await loadProvider('eventbus', config.providers.eventbus, config);

  // Load memory provider, passing LLM for extraction + summary generation + database + eventbus
  const memoryModPath = resolveProviderPath('memory', config.providers.memory);
  const memoryMod = await import(memoryModPath);
  const memory = await memoryMod.create(config, config.providers.memory, { llm: tracedLlm, database, eventbus });

  // Load audit provider — pass database for audit/database provider
  const auditModPath = resolveProviderPath('audit', config.providers.audit);
  const auditMod = await import(auditModPath);
  const audit = await auditMod.create(config, config.providers.audit, { database });

  // Load MCP provider if configured (optional — fast path only).
  // NOTE: providers.mcp is deprecated. New MCP servers should be added via:
  // 1. Database: `ax mcp add` / admin dashboard (loaded into McpConnectionManager at startup)
  // 2. Plugins: `ax plugin install` (loaded into McpConnectionManager on install)
  // The database MCP provider remains as a legacy option until all callers
  // migrate to the unified McpConnectionManager routing path.
  let mcp;
  if (config.providers.mcp === 'database') {
    if (!database) {
      throw new Error('providers.mcp=database requires providers.database to be configured');
    }
    const mcpModPath = resolveProviderPath('mcp', 'database');
    const mcpMod = await import(mcpModPath);
    mcp = await mcpMod.create(config, 'database', { database, credentials });
  } else if (config.providers.mcp) {
    mcp = await loadProvider('mcp', config.providers.mcp, config);
  }

  const registry: ProviderRegistry = {
    llm:         tracedLlm,
    memory,
    security:    await loadSecurity(config, tracedLlm),
    channels,
    webFetch:   await (await import('../providers/web/fetch.js')).create(config),
    webExtract: await loadProvider('web_extract', config.providers.web.extract, config),
    webSearch:  await loadProvider('web_search', config.providers.web.search, config),
    credentials,
    audit,
    sandbox:     await loadProvider('sandbox', config.providers.sandbox, config),
    workspace:   config.providers.workspace ? await loadProvider('workspace', config.providers.workspace, config) : undefined,
    scheduler:   await loadScheduler(config, database, eventbus, storage?.documents),
    storage,
    database,
    eventbus,
    mcp,
    auth: authProviders.length ? authProviders : undefined,
  };

  if (opts?.providerOverrides) {
    Object.assign(registry, opts.providerOverrides);
  }

  return registry;
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

async function loadSecurity(config: Config, llm: import('../providers/llm/types.js').LLMProvider) {
  const securityModPath = resolveProviderPath('security', config.providers.security);
  const securityMod = await import(securityModPath);
  if (typeof securityMod.create !== 'function') {
    throw new Error(`Security provider '${config.providers.security}' does not export a create() function`);
  }
  return securityMod.create(config, config.providers.security, { llm });
}

async function loadScheduler(config: Config, database?: DatabaseProvider, eventbus?: import('../providers/eventbus/types.js').EventBusProvider, documents?: import('../providers/storage/types.js').DocumentStore) {
  const modulePath = resolveProviderPath('scheduler', config.providers.scheduler);
  const mod = await import(modulePath);
  return mod.create(config, { database, eventbus, documents });
}
